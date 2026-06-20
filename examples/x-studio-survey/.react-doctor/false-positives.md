# React Doctor false positives

## no-vulnerable-react-server-components — package.json
`next` is not a direct dependency of this example. React Doctor incorrectly resolves it from the monorepo root or a transitive dep.
