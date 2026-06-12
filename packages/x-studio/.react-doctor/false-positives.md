# React Doctor false positives

## no-vulnerable-react-server-components — package.json
`next` is not a direct dependency of x-studio. React Doctor incorrectly resolves this from the monorepo root or a transitive dep. Suppress until react-doctor supports monorepo-aware scanning.
