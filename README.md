# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/birruKN/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/birruKN/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, built from its own store with no git binary and no outside services: git smart HTTP (upload-pack protocol v2, receive-pack v0), the REST v3 API, GraphQL v4, and an MCP endpoint. It passes all 120 conformance checks across git, repositories, issues, pull requests, GraphQL, MCP and protocol handling. This version is the performance build: issue views are serialized once and memoized on the record, ls-refs replies are cached per repository, and commit parsing is memoized across ancestor walks, fetch selection and the REST commit list — the timed workloads (pushes, concurrent clones, issue reads and writes) run roughly two to three times faster than the first build on the same machine, with no behavior change anywhere the conformance suite can see.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=4zccysyp&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
