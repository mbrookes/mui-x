import type { StudioDataSource } from '@mui/x-studio';
import { generateSalesData } from '../salesData/generator.js';

/* eslint-disable no-bitwise, no-plusplus */
// Intentional: mulberry32 PRNG uses bitwise ops for performance; i++ counters are idiomatic.

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function rng() {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

type Rng = () => number;

function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7)) - 1;
  const d = Number(dateStr.slice(8, 10));
  return isoDate(new Date(Date.UTC(y, m, d + days)));
}

function zeroPad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function makeDateSampler(from: string, to: string): (rng: Rng) => string {
  const a = new Date(from).getTime();
  const span = new Date(to).getTime() - a;
  return (r) => isoDate(new Date(a + r() * span));
}

// ─── Static vocabulary ────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'James',
  'Emma',
  'Liam',
  'Olivia',
  'Noah',
  'Ava',
  'William',
  'Sophia',
  'Benjamin',
  'Isabella',
  'Lucas',
  'Mia',
  'Henry',
  'Charlotte',
  'Alexander',
  'Amelia',
  'Mason',
  'Harper',
  'Ethan',
  'Evelyn',
  'Hans',
  'Petra',
  'Marie',
  'Pierre',
  'Sarah',
  'Michael',
  'Anna',
  'Lars',
  'Ingrid',
  'Piotr',
] as const;

const LAST_NAMES = [
  'Mueller',
  'Schmidt',
  'Schneider',
  'Fischer',
  'Weber',
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Martin',
  'Bernard',
  'Dubois',
  'Thomas',
  'Laurent',
  'Anderson',
  'Taylor',
  'Wilson',
  'Harris',
  'Jackson',
  'Kowalski',
  'Nowak',
  'Jensen',
  'Nielsen',
  'Larsson',
] as const;

const ROLES = [
  'CEO',
  'CFO',
  'CTO',
  'VP Sales',
  'VP Marketing',
  'VP Engineering',
  'Head of Procurement',
  'Head of IT',
  'Account Manager',
  'Sales Director',
  'Procurement Manager',
  'IT Manager',
  'Finance Director',
  'Operations Manager',
  'Business Development Manager',
] as const;

const DEPARTMENTS = [
  'Sales',
  'Finance',
  'IT',
  'Operations',
  'Procurement',
  'Marketing',
  'Executive',
  'Engineering',
] as const;

// Sequential pipeline path (depth 0..4). `Closed Lost` is a *terminal exit*, NOT a
// sequential step, so it is intentionally excluded from this ordered sequence.
const SEQ_STAGES = [
  'Prospecting',
  'Qualification',
  'Proposal',
  'Negotiation',
  'Closed Won',
] as const;

const CLOSED_LOST = 'Closed Lost';

// Display order (keeps BL-173's ordering: Closed Lost sorts last) for widgets/grids.
const DEAL_STAGES = [...SEQ_STAGES, CLOSED_LOST] as const;

// Probability that a deal's *furthest-reached* depth is exactly k (k = 0..4),
// i.e. how far it got along the pipeline. The distribution is **decreasing** so
// that "reached ≥ k" counts fall off as k grows — making the cumulative funnel
// (counted in `aggregateFunnelReached`) monotonically non-increasing by
// construction. Because counts of "reached ≥ k" are derived from these
// exact-depth weights, the funnel can never exceed 100% regardless of seed.
const REACH_DEPTH_WEIGHTS = [0.32, 0.26, 0.2, 0.13, 0.09] as const;

// Of the deals that stalled before Closed Won (depth < 4), this fraction exits
// to `Closed Lost` (terminal). The rest stay open, currently sitting in the
// stage at their reached depth. Deals reaching depth 4 are `Closed Won`.
const LOST_FRACTION = 0.45;

// Typical days a deal spends in each pipeline stage (index = depth). Used to
// derive a coherent stage timeline and a per-deal `daysInStage` scalar.
const STAGE_DURATION_RANGES: ReadonlyArray<readonly [number, number]> = [
  [7, 30], // Prospecting
  [10, 35], // Qualification
  [14, 45], // Proposal
  [10, 40], // Negotiation
  [1, 7], // Closed Won (short — the win is recorded quickly)
];

// A small fixed roster of sales reps — the `owner` axis for the time-in-stage heatmap.
const DEAL_OWNERS = [
  'Sofia Reyes',
  'Marcus Bauer',
  'Priya Nair',
  'Tom Becker',
  'Lena Hofmann',
  'Diego Santos',
] as const;

const ACTIVITY_TYPES = ['Call', 'Email', 'Meeting', 'Demo', 'Follow-up'] as const;

const ACTIVITY_OUTCOMES = [
  'Positive',
  'Neutral',
  'Needs follow-up',
  'No response',
  'Declined',
] as const;

// ─── Source IDs ───────────────────────────────────────────────────────────────

export const CRM_CONTACTS_SOURCE_ID = 'source-crm-contacts';
export const CRM_DEALS_SOURCE_ID = 'source-crm-deals';
export const CRM_ACTIVITIES_SOURCE_ID = 'source-crm-activities';

// ─── Generator options ────────────────────────────────────────────────────────

export interface CrmGeneratorOptions {
  /**
   * Integer seed for the PRNG. Must match the seed used for `generateSalesData`
   * so customer IDs are identical. Default: 42.
   */
  seed?: number;
  /**
   * Number of orders (same as in generateSalesData). Used to derive the
   * customer count so company references always match. Default: 220.
   */
  orderCount?: number;
}

export interface GeneratedCrmData {
  contactsSource: StudioDataSource;
  dealsSource: StudioDataSource;
  activitiesSource: StudioDataSource;
}

// ─── Individual table generators ─────────────────────────────────────────────

interface GeneratedContact extends Record<string, unknown> {
  id: string;
  customerId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  role: string;
  department: string;
}

function generateContacts(
  rng: Rng,
  customerRows: Record<string, unknown>[],
): {
  source: StudioDataSource;
  rows: GeneratedContact[];
  byCustomerId: Map<string, GeneratedContact[]>;
} {
  const rows: GeneratedContact[] = [];
  const byCustomerId = new Map<string, GeneratedContact[]>();
  let contactIdx = 1;

  for (const customer of customerRows) {
    const customerId = customer.id as string;
    const company = (customer.company as string).toLowerCase().replace(/\s+/g, '');
    const count = randInt(rng, 2, 4);
    const customerContacts: GeneratedContact[] = [];

    for (let j = 0; j < count; j++) {
      const firstName = pick(rng, FIRST_NAMES);
      const lastName = pick(rng, LAST_NAMES);
      const contact: GeneratedContact = {
        id: `CON-${zeroPad(contactIdx, 4)}`,
        customerId,
        firstName,
        lastName,
        email: `${firstName.toLowerCase().charAt(0)}.${lastName.toLowerCase()}@${company}.com`,
        phone: `+${randInt(rng, 1, 99)}-${randInt(rng, 100, 999)}-${randInt(rng, 1000000, 9999999)}`,
        role: pick(rng, ROLES),
        department: pick(rng, DEPARTMENTS),
      };
      rows.push(contact);
      customerContacts.push(contact);
      contactIdx++;
    }

    byCustomerId.set(customerId, customerContacts);
  }

  return {
    source: {
      id: CRM_CONTACTS_SOURCE_ID,
      label: 'CRM Contacts',
      tableName: 'contacts',
      fields: [
        { id: 'id', label: 'Contact ID', type: 'string', hidden: true },
        { id: 'customerId', label: 'Company ID', type: 'string', hidden: true },
        { id: 'firstName', label: 'First Name', type: 'string' },
        { id: 'lastName', label: 'Last Name', type: 'string' },
        { id: 'email', label: 'Email', type: 'string' },
        { id: 'phone', label: 'Phone', type: 'string' },
        { id: 'role', label: 'Role', type: 'string' },
        { id: 'department', label: 'Department', type: 'string' },
      ],
      rows,
    },
    rows,
    byCustomerId,
  };
}

/**
 * One entry of a deal's stage timeline: when it entered/exited a pipeline stage.
 * Used only locally to derive a coherent `daysInStage` scalar and `closeDate`;
 * it is intentionally NOT emitted as a row field (a nested array would not map
 * to a flat data-source column / SQL ingest).
 */
interface DealStageInterval {
  stage: string;
  enteredDate: string;
  /** `null` while the deal currently sits in this (last) stage. */
  exitedDate: string | null;
  days: number;
}

interface GeneratedDeal extends Record<string, unknown> {
  id: string;
  customerId: string;
  title: string;
  /** Snapshot stage the deal is *currently* sitting in (or its terminal outcome). */
  stage: string;
  /**
   * Furthest-reached depth index along `SEQ_STAGES` (0..4). Drives the cumulative
   * "reached stage" funnel. A deal that exited to Closed Lost keeps the depth it
   * had reached, so it still counts toward the upper stages it passed through.
   */
  stageReached: number;
  /** Sales rep who owns the deal — the heatmap row axis. */
  owner: string;
  value: number;
  probability: number;
  /**
   * Days spent in the current/snapshot stage. NOTE: this is a per-deal *scalar*
   * (the heatmap reads one row per deal), not a full per-stage matrix. It
   * approximates "time in stage" with the duration of the deal's current stage.
   */
  daysInStage: number;
  openedDate: string;
  closeDate: string;
}

function pickWeighted<T>(rng: Rng, options: readonly T[], weights: readonly number[]): T {
  const r = rng();
  let cumulative = 0;
  for (let i = 0; i < options.length; i++) {
    cumulative += weights[i];
    if (r < cumulative) {
      return options[i];
    }
  }
  return options[options.length - 1];
}

const DEAL_TITLE_TEMPLATES = [
  'Enterprise License Renewal',
  'Software Upgrade Package',
  'Hardware Refresh Initiative',
  'Cloud Migration Project',
  'IT Support Contract',
  'Network Infrastructure Upgrade',
  'Security Suite Deployment',
  'Annual Maintenance Agreement',
  'Professional Services Engagement',
  'Digital Transformation Package',
] as const;

function generateDeals(
  rng: Rng,
  customerRows: Record<string, unknown>[],
  byCustomerId: Map<string, GeneratedContact[]>,
): { source: StudioDataSource; rows: GeneratedDeal[]; byDealId: Map<string, GeneratedDeal> } {
  const rows: GeneratedDeal[] = [];
  const byDealId = new Map<string, GeneratedDeal>();
  let dealIdx = 1;

  const today = new Date();
  const twoYearsAgo = new Date(today);
  twoYearsAgo.setFullYear(today.getFullYear() - 2);
  const oneYearAhead = new Date(today);
  oneYearAhead.setFullYear(today.getFullYear() + 1);

  const sampleOpenedDate = makeDateSampler(isoDate(twoYearsAgo), isoDate(today));

  for (const customer of customerRows) {
    const customerId = customer.id as string;
    const dealCount = randInt(rng, 0, 3);

    for (let j = 0; j < dealCount; j++) {
      // 1. Draw a furthest-reached depth from a decreasing distribution. Counts
      //    of "reached ≥ k" then fall off monotonically by construction.
      const stageReached = SEQ_STAGES.indexOf(pickWeighted(rng, SEQ_STAGES, REACH_DEPTH_WEIGHTS));

      // 2. Win/lost split. Reaching Closed Won (depth 4) = won. Otherwise the
      //    deal either exited to Closed Lost or is still open in its reached stage.
      const reachedWon = stageReached >= SEQ_STAGES.length - 1;
      const isLost = !reachedWon && rng() < LOST_FRACTION;
      const stage = reachedWon ? 'Closed Won' : isLost ? CLOSED_LOST : SEQ_STAGES[stageReached];

      const value = Math.round(randInt(rng, 5000, 250000) / 500) * 500;
      const probability = reachedWon
        ? 100
        : isLost
          ? 0
          : stage === 'Negotiation'
            ? randInt(rng, 60, 80)
            : stage === 'Proposal'
              ? randInt(rng, 40, 60)
              : stage === 'Qualification'
                ? randInt(rng, 20, 40)
                : randInt(rng, 5, 20);

      const openedDate = sampleOpenedDate(rng);

      // 3. Build a coherent stage timeline across the stages the deal passed
      //    through (0..stageReached), with per-stage durations. closeDate is the
      //    sum of all durations so it stays consistent with openedDate.
      const stageTimeline: DealStageInterval[] = [];
      let cursor = openedDate;
      for (let d = 0; d <= stageReached; d++) {
        const [lo, hi] = STAGE_DURATION_RANGES[d];
        const days = randInt(rng, lo, hi);
        const enteredDate = cursor;
        const exitedDate = d < stageReached ? addDays(enteredDate, days) : null;
        stageTimeline.push({ stage: SEQ_STAGES[d], enteredDate, exitedDate, days });
        cursor = exitedDate ?? addDays(enteredDate, days);
      }
      // Days the deal has spent in its current/snapshot stage (heatmap value).
      const daysInStage = stageTimeline[stageTimeline.length - 1]?.days ?? 0;
      // closeDate = opened + all stage durations (terminal for won/lost; for
      // still-open deals it is the projected close based on time-in-stage so far).
      const closeDate = cursor;

      // Assign primary contact from this company (first one if available)
      const contacts = byCustomerId.get(customerId) ?? [];
      const primaryContactId = contacts.length > 0 ? contacts[0].id : null;

      const deal: GeneratedDeal = {
        id: `DEAL-${zeroPad(dealIdx, 5)}`,
        customerId,
        primaryContactId,
        title: pick(rng, DEAL_TITLE_TEMPLATES),
        stage,
        stageReached,
        owner: pick(rng, DEAL_OWNERS),
        value,
        probability,
        daysInStage,
        openedDate,
        closeDate,
      };

      rows.push(deal);
      byDealId.set(deal.id, deal);
      dealIdx++;
    }
  }

  return {
    source: {
      id: CRM_DEALS_SOURCE_ID,
      label: 'CRM Deals',
      tableName: 'deals',
      fields: [
        { id: 'id', label: 'Deal ID', type: 'string', hidden: true },
        { id: 'customerId', label: 'Company ID', type: 'string', hidden: true },
        { id: 'primaryContactId', label: 'Contact ID', type: 'string', hidden: true },
        { id: 'title', label: 'Deal Title', type: 'string' },
        {
          id: 'stage',
          label: 'Stage',
          type: 'string',
          // Display order keeps Closed Lost last (BL-173); it is a terminal exit,
          // not a sequential step in the funnel math.
          orderedValues: [...DEAL_STAGES],
        },
        {
          id: 'stageReached',
          label: 'Stage Reached',
          type: 'number',
          format: 'integer',
          hidden: true,
        },
        { id: 'owner', label: 'Owner', type: 'string' },
        { id: 'value', label: 'Deal Value', type: 'number', format: 'currency' },
        { id: 'probability', label: 'Probability', type: 'number', format: 'percent' },
        { id: 'daysInStage', label: 'Days in Stage', type: 'number', format: 'integer' },
        { id: 'openedDate', label: 'Opened', type: 'date' },
        { id: 'closeDate', label: 'Close Date', type: 'date' },
      ],
      rows,
    },
    rows,
    byDealId,
  };
}

interface GeneratedActivity extends Record<string, unknown> {
  id: string;
  contactId: string;
  dealId: string | null;
  type: string;
  date: string;
  outcome: string;
  durationMin: number;
}

function generateActivities(
  rng: Rng,
  deals: GeneratedDeal[],
  byCustomerId: Map<string, GeneratedContact[]>,
): StudioDataSource {
  const rows: GeneratedActivity[] = [];
  let actIdx = 1;

  const today = new Date();
  const twoYearsAgo = new Date(today);
  twoYearsAgo.setFullYear(today.getFullYear() - 2);
  const sampleDate = makeDateSampler(isoDate(twoYearsAgo), isoDate(today));

  for (const deal of deals) {
    const contacts = byCustomerId.get(deal.customerId) ?? [];
    if (contacts.length === 0) {
      continue;
    }
    const activityCount = randInt(rng, 1, 5);
    for (let j = 0; j < activityCount; j++) {
      const contact = pick(rng, contacts);
      rows.push({
        id: `ACT-${zeroPad(actIdx, 5)}`,
        contactId: contact.id,
        dealId: deal.id,
        type: pick(rng, ACTIVITY_TYPES),
        date: sampleDate(rng),
        outcome: pick(rng, ACTIVITY_OUTCOMES),
        durationMin: randInt(rng, 15, 90),
      });
      actIdx++;
    }
  }

  return {
    id: CRM_ACTIVITIES_SOURCE_ID,
    label: 'CRM Activities',
    tableName: 'activities',
    fields: [
      { id: 'id', label: 'Activity ID', type: 'string', hidden: true },
      { id: 'contactId', label: 'Contact ID', type: 'string', hidden: true },
      { id: 'dealId', label: 'Deal ID', type: 'string', hidden: true },
      { id: 'type', label: 'Type', type: 'string' },
      { id: 'date', label: 'Date', type: 'date' },
      { id: 'outcome', label: 'Outcome', type: 'string' },
      { id: 'durationMin', label: 'Duration (min)', type: 'number', format: 'integer' },
    ],
    rows,
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a coherent set of CRM data sources whose company IDs (`customerId`)
 * match those produced by `generateSalesData` with the same `seed` and `orderCount`.
 *
 * CRM tables: contacts, deals, activities.
 *
 * @param opts.seed - Integer seed. Must match the seed used for `generateSalesData`. Default: 42.
 * @param opts.orderCount - Number of orders (determines customer count). Default: 220.
 */
export function generateCrmData(opts?: CrmGeneratorOptions): GeneratedCrmData {
  const seed = opts?.seed ?? 42;
  const orderCount = opts?.orderCount ?? 220;

  // Re-generate customers using the same seed so CUS-xxx IDs and company names match.
  // This is a pure reproduction — no side effects on the sales PRNG.
  const { customersSource } = generateSalesData({ seed, orderCount });
  const customerRows = customersSource.rows ?? [];

  // CRM PRNG is seeded at seed + 1_000_000 to avoid any overlap with the sales PRNG sequence.
  const rng = mulberry32(seed + 1_000_000);

  const { source: contactsSource, byCustomerId } = generateContacts(rng, customerRows);
  const {
    source: dealsSource,
    rows: dealRows,
    byDealId: _,
  } = generateDeals(rng, customerRows, byCustomerId);
  const activitiesSource = generateActivities(rng, dealRows, byCustomerId);

  return { contactsSource, dealsSource, activitiesSource };
}
