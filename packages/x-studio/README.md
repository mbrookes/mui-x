# MUI X Studio

An embedded analytics studio for building interactive dashboards inside your app.
It's part of [MUI X](https://mui.com/x/), an open-core extension of our Core libraries, with advanced components.

## Installation

Install the package in your project directory with:

```bash
npm install @mui/x-studio
```

This component has the following peer dependencies that you need to install as well.

```json
"peerDependencies": {
  "react": "^17.0.0 || ^18.0.0 || ^19.0.0",
  "@emotion/react": "^11.9.0",
  "@emotion/styled": "^11.8.1",
  "@mui/icons-material": "^5.0.0 || ^6.0.0 || ^7.0.0 || ^9.0.0",
  "@mui/material": "^5.15.14 || ^6.0.0 || ^7.0.0 || ^9.0.0",
}
```

## Documentation

Visit [https://mui.com/x/react-studio/](https://mui.com/x/react-studio/) to view the full documentation.

## Package documentation

Additional MUI developer reference documentation in this package:

| Document                                                                  | Description                                                                                           |
| :------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------- |
| Planning                                                                  |
| [AG_STUDIO_CLONE_REQUIREMENTS.md](./docs/AG_STUDIO_CLONE_REQUIREMENTS.md) | Feature requirements modelled on AG Studio                                                            |
| [AG_STUDIO_GAP_ANALYSIS.md](./docs/AG_STUDIO_GAP_ANALYSIS.md)             | Gap analysis against AG Studio clone requirements                                                     |
| [X_STUDIO_PROGRESS.md](./docs/X_STUDIO_PROGRESS.md)                       | Requirements progress tracker                                                                         |
| [BACKLOG.md](./docs/BACKLOG.md)                                           | Known issues and planned work                                                                         |
| Architecture                                                              |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md)                                 | Component architecture, `StudioController`, data pipeline, and slot system                            |
| AI Assistant                                                              |
| [AI_ASSISTANT_OVERVIEW.md](./docs/AI_ASSISTANT_OVERVIEW.md)               | AI agent reference: all 12 tools, SSE pipeline, insight generation, and data isolation                |
| [AI_ASSISTANT_RESEARCH.md](./docs/AI_ASSISTANT_RESEARCH.md)               | Market research, gap analysis, and roadmap for AI assistant features                                  |
| Performance                                                               |
| [DATA_PIPELINE_PERFORMANCE.md](./docs/DATA_PIPELINE_PERFORMANCE.md)       | Consolidated data pipeline performance history: research, optimizations, benchmarks, and architecture |
| [DATA_PIPELINE_PERF_RESULTS.md](./docs/DATA_PIPELINE_PERF_RESULTS.md)     | Pipeline benchmark results                                                                            |
| [UI_PERFORMANCE_TESTING.md](./docs/UI_PERFORMANCE_TESTING.md)             | UI performance review and optimisation notes                                                          |
