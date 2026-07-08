import type { DatasetRow, VegaCalculateTransform } from '../types';
import type { GapCollector } from '../gaps';
import { toDate } from '../compile/fieldTypes';

/*
 * OWNERSHIP: the "transforms" work unit owns this file.
 *
 * A small, hand-rolled, SAFE recursive-descent parser + evaluator for the
 * common subset of the Vega expression language used in `calculate`
 * transforms and `filter` expression strings (filter.ts reuses
 * `compileExpression`). This NEVER uses `eval()`/`new Function()` — untrusted
 * spec strings are tokenized and parsed into a small AST, then interpreted
 * directly against the row (`datum`).
 *
 * Supported grammar (roughly, in precedence order):
 *   ternary     := logicalOr ('?' ternary ':' ternary)?
 *   logicalOr   := logicalAnd ('||' logicalAnd)*
 *   logicalAnd  := equality ('&&' equality)*
 *   equality    := relational (('=='|'==='|'!='|'!==') relational)*
 *   relational  := additive (('<'|'<='|'>'|'>=') additive)*
 *   additive    := multiplicative (('+'|'-') multiplicative)*
 *   multiplicative := unary (('*'|'/'|'%') unary)*
 *   unary       := ('!'|'-'|'+') unary | postfix
 *   postfix     := primary ('.' ident | '[' ternary ']')*
 *   primary     := number | string | 'true' | 'false' | 'null'
 *                | ident ('(' args ')')?
 *                | '(' ternary ')'
 *
 * `datum` is the only recognized bare identifier; `datum.field` /
 * `datum['field']` reads a row property (including chained/nested access).
 * A short allow-list of pure functions is supported: abs, round, floor,
 * ceil, sqrt, min, max, length, upper, lower, toNumber, toString, year,
 * month, date. Anything outside this subset — other identifiers, unknown
 * functions, or a syntax error — throws `UnsupportedExpressionError`, which
 * callers turn into a `TranslationGap` instead of failing the whole chart.
 */

export class UnsupportedExpressionError extends Error {}

class ExpressionSyntaxError extends Error {}

type Token =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'punct'; value: string };

const TWO_CHAR_PUNCT = ['==', '!=', '<=', '>=', '&&', '||'];
const THREE_CHAR_PUNCT = ['===', '!=='];
const SINGLE_CHAR_PUNCT = '+-*/%()[].,?:<>!';

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9.]/.test(source[j])) {
        j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        j += 1;
        if (source[j] === '+' || source[j] === '-') {
          j += 1;
        }
        while (j < n && /[0-9]/.test(source[j])) {
          j += 1;
        }
      }
      const text = source.slice(i, j);
      const value = Number(text);
      if (Number.isNaN(value)) {
        throw new ExpressionSyntaxError(`Invalid number literal "${text}"`);
      }
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== quote) {
        if (source[j] === '\\' && j + 1 < n) {
          const escapeMap: Record<string, string> = {
            n: '\n',
            t: '\t',
            '\\': '\\',
            "'": "'",
            '"': '"',
          };
          const next = source[j + 1];
          value += escapeMap[next] ?? next;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= n) {
        throw new ExpressionSyntaxError('Unterminated string literal');
      }
      tokens.push({ type: 'str', value });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) {
        j += 1;
      }
      tokens.push({ type: 'ident', value: source.slice(i, j) });
      i = j;
      continue;
    }
    const three = source.slice(i, i + 3);
    if (THREE_CHAR_PUNCT.includes(three)) {
      tokens.push({ type: 'punct', value: three });
      i += 3;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_PUNCT.includes(two)) {
      tokens.push({ type: 'punct', value: two });
      i += 2;
      continue;
    }
    if (SINGLE_CHAR_PUNCT.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new ExpressionSyntaxError(`Unexpected character "${ch}"`);
  }
  return tokens;
}

type Node =
  | { kind: 'literal'; value: unknown }
  | { kind: 'ident'; name: string }
  | { kind: 'member'; object: Node; property: Node; computed: boolean }
  | { kind: 'call'; callee: string; args: Node[] }
  | { kind: 'unary'; op: string; arg: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'logical'; op: '&&' | '||'; left: Node; right: Node }
  | { kind: 'conditional'; test: Node; consequent: Node; alternate: Node };

const RELATIONAL_OPS = ['<', '<=', '>', '>='];
const EQUALITY_OPS = ['==', '===', '!=', '!=='];
const ADDITIVE_OPS = ['+', '-'];
const MULTIPLICATIVE_OPS = ['*', '/', '%'];
const UNARY_OPS = ['!', '-', '+'];

class Parser {
  private pos = 0;

  constructor(private tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private peekPunct(): string | undefined {
    const token = this.peek();
    return token?.type === 'punct' ? token.value : undefined;
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    if (!token) {
      throw new ExpressionSyntaxError('Unexpected end of expression');
    }
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.advance();
    if (token.type !== 'punct' || token.value !== value) {
      throw new ExpressionSyntaxError(`Expected "${value}"`);
    }
  }

  parseProgram(): Node {
    const node = this.parseTernary();
    if (this.pos !== this.tokens.length) {
      throw new ExpressionSyntaxError('Unexpected trailing tokens');
    }
    return node;
  }

  private parseTernary(): Node {
    const test = this.parseLogicalOr();
    if (this.peekPunct() === '?') {
      this.advance();
      const consequent = this.parseTernary();
      this.expectPunct(':');
      const alternate = this.parseTernary();
      return { kind: 'conditional', test, consequent, alternate };
    }
    return test;
  }

  private parseLogicalOr(): Node {
    let left = this.parseLogicalAnd();
    while (this.peekPunct() === '||') {
      this.advance();
      left = { kind: 'logical', op: '||', left, right: this.parseLogicalAnd() };
    }
    return left;
  }

  private parseLogicalAnd(): Node {
    let left = this.parseEquality();
    while (this.peekPunct() === '&&') {
      this.advance();
      left = { kind: 'logical', op: '&&', left, right: this.parseEquality() };
    }
    return left;
  }

  private parseBinaryLevel(ops: string[], next: () => Node): Node {
    let left = next();
    let op = this.peekPunct();
    while (op !== undefined && ops.includes(op)) {
      this.advance();
      left = { kind: 'binary', op, left, right: next() };
      op = this.peekPunct();
    }
    return left;
  }

  private parseEquality(): Node {
    return this.parseBinaryLevel(EQUALITY_OPS, () => this.parseRelational());
  }

  private parseRelational(): Node {
    return this.parseBinaryLevel(RELATIONAL_OPS, () => this.parseAdditive());
  }

  private parseAdditive(): Node {
    return this.parseBinaryLevel(ADDITIVE_OPS, () => this.parseMultiplicative());
  }

  private parseMultiplicative(): Node {
    return this.parseBinaryLevel(MULTIPLICATIVE_OPS, () => this.parseUnary());
  }

  private parseUnary(): Node {
    const op = this.peekPunct();
    if (op !== undefined && UNARY_OPS.includes(op)) {
      this.advance();
      return { kind: 'unary', op, arg: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      if (this.peekPunct() === '.') {
        this.advance();
        const token = this.advance();
        if (token.type !== 'ident') {
          throw new ExpressionSyntaxError('Expected property name after "."');
        }
        node = {
          kind: 'member',
          object: node,
          property: { kind: 'literal', value: token.value },
          computed: false,
        };
      } else if (this.peekPunct() === '[') {
        this.advance();
        const property = this.parseTernary();
        this.expectPunct(']');
        node = { kind: 'member', object: node, property, computed: true };
      } else {
        break;
      }
    }
    return node;
  }

  private parsePrimary(): Node {
    const token = this.peek();
    if (!token) {
      throw new ExpressionSyntaxError('Unexpected end of expression');
    }
    if (token.type === 'num' || token.type === 'str') {
      this.advance();
      return { kind: 'literal', value: token.value };
    }
    if (token.type === 'punct' && token.value === '(') {
      this.advance();
      const node = this.parseTernary();
      this.expectPunct(')');
      return node;
    }
    if (token.type === 'ident') {
      this.advance();
      if (token.value === 'true') {
        return { kind: 'literal', value: true };
      }
      if (token.value === 'false') {
        return { kind: 'literal', value: false };
      }
      if (token.value === 'null') {
        return { kind: 'literal', value: null };
      }
      if (this.peekPunct() === '(') {
        this.advance();
        const args: Node[] = [];
        if (this.peekPunct() !== ')') {
          args.push(this.parseTernary());
          while (this.peekPunct() === ',') {
            this.advance();
            args.push(this.parseTernary());
          }
        }
        this.expectPunct(')');
        return { kind: 'call', callee: token.value, args };
      }
      return { kind: 'ident', name: token.value };
    }
    throw new ExpressionSyntaxError('Unexpected token');
  }
}

function asNumber(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  return Number(value);
}

function stringify(value: unknown): string {
  if (value == null) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

function toComparable(value: unknown): number | string {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

/**
 * Ordering comparison shared by the expression evaluator (`<`, `<=`, `>`,
 * `>=`) and filter.ts's field predicates (lt/lte/gt/gte/range). Dates
 * compare by timestamp. When either side is (or coerces to) a number, both
 * sides are compared numerically — so `"10" < 9` is false, matching JS's own
 * relational coercion — falling back to string comparison only when neither
 * side is numeric.
 */
export function compareValues(a: unknown, b: unknown): number {
  const ca = toComparable(a);
  const cb = toComparable(b);
  if (typeof ca === 'number' || typeof cb === 'number') {
    const na = typeof ca === 'number' ? ca : Number(ca);
    const nb = typeof cb === 'number' ? cb : Number(cb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      return na - nb;
    }
  }
  return String(ca).localeCompare(String(cb));
}

/**
 * Loose equality shared by the expression evaluator (`==`, `!=`) and
 * filter.ts's `equal`/`oneOf` predicates. Dates compare by timestamp
 * (against another Date or anything date-coercible via number/string), and a
 * number compared to a numeric string coerces numerically (`5 == "5"`),
 * matching JS loose-equality semantics for the common Vega-Lite cases.
 */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a instanceof Date || b instanceof Date) {
    const da = a instanceof Date ? a : toDate(a);
    const db = b instanceof Date ? b : toDate(b);
    return da != null && db != null && da.getTime() === db.getTime();
  }
  if (typeof a === 'number' || typeof b === 'number') {
    if (a == null || b == null) {
      return false;
    }
    const na = Number(a);
    const nb = Number(b);
    return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb;
  }
  return false;
}

/** Vega-expression-style truthiness (matches JS truthiness closely enough for this subset). */
export function isTruthy(value: unknown): boolean {
  return Boolean(value);
}

const FUNCTIONS: Record<string, (args: unknown[]) => unknown> = {
  abs: (args) => Math.abs(asNumber(args[0])),
  round: (args) => Math.round(asNumber(args[0])),
  floor: (args) => Math.floor(asNumber(args[0])),
  ceil: (args) => Math.ceil(asNumber(args[0])),
  sqrt: (args) => Math.sqrt(asNumber(args[0])),
  min: (args) => Math.min(...args.map(asNumber)),
  max: (args) => Math.max(...args.map(asNumber)),
  length: (args) => {
    const value = args[0];
    if (typeof value === 'string' || Array.isArray(value)) {
      return value.length;
    }
    return 0;
  },
  upper: (args) => stringify(args[0]).toUpperCase(),
  lower: (args) => stringify(args[0]).toLowerCase(),
  toNumber: (args) => {
    const value = Number(args[0]);
    return Number.isNaN(value) ? null : value;
  },
  // Explicit parameter type: the `toString` key's contextual type gets
  // captured by Object.prototype.toString instead of the Record signature.
  toString: (args: unknown[]) => stringify(args[0]),
  year: (args) => toDate(args[0])?.getFullYear() ?? null,
  month: (args) => toDate(args[0])?.getMonth() ?? null,
  date: (args) => toDate(args[0])?.getDate() ?? null,
};

function evaluateNode(node: Node, datum: DatasetRow): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'ident':
      if (node.name === 'datum') {
        return datum;
      }
      throw new UnsupportedExpressionError(`Unsupported identifier "${node.name}"`);
    case 'member': {
      const object = evaluateNode(node.object, datum);
      const property = node.computed
        ? evaluateNode(node.property, datum)
        : (node.property as { value: string }).value;
      if (object == null) {
        return undefined;
      }
      return (object as Record<string, unknown>)[String(property)];
    }
    case 'call': {
      const fn = FUNCTIONS[node.callee];
      if (!fn) {
        throw new UnsupportedExpressionError(`Unsupported function "${node.callee}"`);
      }
      return fn(node.args.map((arg) => evaluateNode(arg, datum)));
    }
    case 'unary': {
      const value = evaluateNode(node.arg, datum);
      if (node.op === '!') {
        return !isTruthy(value);
      }
      if (node.op === '-') {
        return -asNumber(value);
      }
      if (node.op === '+') {
        return asNumber(value);
      }
      throw new UnsupportedExpressionError(`Unsupported unary operator "${node.op}"`);
    }
    case 'logical': {
      const left = evaluateNode(node.left, datum);
      if (node.op === '&&') {
        return isTruthy(left) ? evaluateNode(node.right, datum) : left;
      }
      return isTruthy(left) ? left : evaluateNode(node.right, datum);
    }
    case 'conditional': {
      const test = evaluateNode(node.test, datum);
      return isTruthy(test)
        ? evaluateNode(node.consequent, datum)
        : evaluateNode(node.alternate, datum);
    }
    case 'binary': {
      const left = evaluateNode(node.left, datum);
      const right = evaluateNode(node.right, datum);
      switch (node.op) {
        case '+':
          if (typeof left === 'string' || typeof right === 'string') {
            return `${stringify(left)}${stringify(right)}`;
          }
          return asNumber(left) + asNumber(right);
        case '-':
          return asNumber(left) - asNumber(right);
        case '*':
          return asNumber(left) * asNumber(right);
        case '/':
          return asNumber(left) / asNumber(right);
        case '%':
          return asNumber(left) % asNumber(right);
        case '<':
          return compareValues(left, right) < 0;
        case '<=':
          return compareValues(left, right) <= 0;
        case '>':
          return compareValues(left, right) > 0;
        case '>=':
          return compareValues(left, right) >= 0;
        // `==`/`!=` follow JS loose equality for the common cases (numeric
        // string vs number, Dates by timestamp); `===`/`!==` stay strict
        // (Dates still compare by timestamp — identity comparison of two
        // Date objects is never useful in a data expression).
        case '==':
          return looseEquals(left, right);
        case '!=':
          return !looseEquals(left, right);
        case '===':
          return (
            left === right ||
            (left instanceof Date && right instanceof Date && left.getTime() === right.getTime())
          );
        case '!==':
          return !(
            left === right ||
            (left instanceof Date && right instanceof Date && left.getTime() === right.getTime())
          );
        default:
          throw new UnsupportedExpressionError(`Unsupported operator "${node.op}"`);
      }
    }
    default:
      throw new UnsupportedExpressionError('Unsupported expression');
  }
}

/**
 * Parses `source` as a Vega expression (the supported subset) and returns an
 * evaluator function. Throws `UnsupportedExpressionError` synchronously for
 * anything outside the subset (syntax errors surface the same way). Runtime
 * evaluation can also throw `UnsupportedExpressionError` for constructs only
 * reachable via a particular row's data (e.g. an unsupported function called
 * from inside an untaken ternary branch for most rows).
 */
export function compileExpression(source: string): (datum: DatasetRow) => unknown {
  let ast: Node;
  try {
    ast = new Parser(tokenize(source)).parseProgram();
  } catch (err) {
    if (err instanceof ExpressionSyntaxError) {
      throw new UnsupportedExpressionError(err.message);
    }
    throw err;
  }
  return (datum: DatasetRow) => evaluateNode(ast, datum);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeCalculatedValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isNaN(value)) {
    return null;
  }
  return value;
}

/*
 * `calculate` transform: evaluates a Vega expression string per row and
 * writes the result to `as`. Parse failures (or per-row evaluation failures
 * for unsupported syntax) are reported once per transform (GapCollector
 * dedups by code+path) and leave `as` null for the affected rows.
 */
export function applyCalculateTransform(
  rows: readonly DatasetRow[],
  transform: VegaCalculateTransform,
  gaps: GapCollector,
  path: string,
): readonly DatasetRow[] {
  let evaluator: (datum: DatasetRow) => unknown;
  try {
    evaluator = compileExpression(transform.calculate);
  } catch (err) {
    if (!(err instanceof UnsupportedExpressionError)) {
      throw err;
    }
    gaps.add({
      code: 'transform:calculate',
      message: `The \`calculate\` expression "${transform.calculate}" could not be parsed (${errorMessage(err)}); "${transform.as}" is null.`,
      severity: 'unsupported',
      path,
    });
    return rows.map((row) => ({ ...row, [transform.as]: null }));
  }

  return rows.map((row) => {
    try {
      return { ...row, [transform.as]: normalizeCalculatedValue(evaluator(row)) };
    } catch (err) {
      // Only UnsupportedExpressionError is an expected outcome here (an
      // unsupported construct reached at runtime, e.g. inside a ternary
      // branch only some rows take). Anything else is a bug in this
      // evaluator — rethrow instead of masking it as a spec-feature gap.
      if (!(err instanceof UnsupportedExpressionError)) {
        throw err;
      }
      gaps.add({
        code: 'transform:calculate',
        message: `The \`calculate\` expression "${transform.calculate}" uses unsupported syntax (${errorMessage(err)}) for some rows; "${transform.as}" is null there.`,
        severity: 'unsupported',
        path,
      });
      return { ...row, [transform.as]: null };
    }
  });
}
