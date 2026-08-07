"""Runtime-import closure check for @mui/x-studio.

Reports which files are reachable without React at RUNTIME. `import type` is erased by the
compiler, so it is ignored here — a type-only edge costs nothing in a bundle.
Run from packages/x-studio/src.
"""
import re, os, glob, sys
from collections import defaultdict, deque, Counter

files = [f for f in glob.glob('**/*.ts', recursive=True) + glob.glob('**/*.tsx', recursive=True)
         if '.test.' not in f]
IMP = re.compile(r"""^\s*(import|export)\s+(type\s+)?(?:[\s\S]*?)from\s+['"]([^'"]+)['"]""", re.M)

def resolve(src, spec):
    if not spec.startswith('.'):
        return None
    b = os.path.normpath(os.path.join(os.path.dirname(src), spec))
    for c in (b + '.ts', b + '.tsx', b + '/index.ts', b + '/index.tsx'):
        if os.path.exists(c):
            return c
    return None

vdeps, vext = defaultdict(set), defaultdict(set)
for f in files:
    for m in IMP.finditer(open(f).read()):
        if m.group(2):           # `import type` — erased
            continue
        r = resolve(f, m.group(3))
        (vdeps[f].add(r) if r else vext[f].add(m.group(3)))

REACTY = ('react', 'react-dom', '@mui/material', '@mui/icons-material', '@emotion', '@mui/system',
          '@mui/utils', '@mui/lab', '@mui/x-charts', '@mui/x-data-grid', '@mui/x-date-pickers',
          '@mui/x-tree-view', '@mui/x-chat', '@dnd-kit')
def self_tainted(f):
    return f.endswith('.tsx') or any(
        any(e == r or e.startswith(r + '/') for r in REACTY) for e in vext[f])

tainted = {f for f in files if self_tainted(f)}
changed = True
while changed:
    changed = False
    for f in files:
        if f not in tainted and (vdeps[f] & tainted):
            tainted.add(f); changed = True

clean = [f for f in files if f not in tainted]
def loc(fs):
    return sum(len([l for l in open(f)
                    if l.strip() and not l.strip().startswith(('//', '*', '/*', '*/'))]) for f in fs)

print(f"runtime-clean: {len(clean)} files, {loc(clean)} code lines")
print(f"React-coupled: {len(tainted)} files, {loc(list(tainted))} code lines")
ENGINE = ('store/', 'internals/', 'server/', 'utils/', 'models/', 'locales/')
eng = [f for f in files if f.startswith(ENGINE)]
blocked = [f for f in eng if f in tainted]
print(f"\nengine dirs: {len(eng)} files ({loc(eng)} lines)")
print(f"  clean:   {len(eng)-len(blocked)} ({loc([f for f in eng if f not in tainted])} lines)")
print(f"  blocked: {len(blocked)} ({loc(blocked)} lines)")
if blocked:
    print("\n  blocked engine files:")
    for f in sorted(blocked):
        print(f"    {f}")
for probe in ('store/StudioController.ts', 'internals/StudioPipeline.ts',
              'server/createBatchingAdapter.ts', 'internals/widgetConfigSanitization.ts'):
    if probe in files:
        print(f"\n{probe}: {'CLEAN' if probe in clean else 'TAINTED'}")
        if probe in tainted and not self_tainted(probe):
            seen = {probe: None}; q = deque([probe])
            while q:
                n = q.popleft()
                if self_tainted(n):
                    p = []
                    while n is not None: p.append(n); n = seen[n]
                    print("   via " + " -> ".join(reversed(p))); break
                for d in vdeps[n]:
                    if d not in seen: seen[d] = n; q.append(d)
