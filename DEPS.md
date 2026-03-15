# Dependencies

## Tool Versioning (mise.toml)

All tool versions are pinned via [mise-en-place](https://mise.jdx.dev/):

```toml
[tools]
node = "25"
pnpm = "10"
```

## System Dependencies

### macOS
```bash
brew install mise
mise install
```

### Linux (Debian/Ubuntu)
```bash
sudo apt update
sudo apt install -y git curl jq unzip sqlite3 build-essential python3 ca-certificates
# Install mise: https://mise.jdx.dev/getting-started.html
mise install
```

## Node Dependencies (managed by pnpm)

### Core Pipeline
| Package | Purpose |
|---|---|
| `dependency-cruiser` | Circular dependency detection via structured JSON output |
| `ts-morph` | TypeScript Compiler API wrapper for semantic analysis |
| `jscodeshift` | Codemod engine for safe AST rewrites |
| `recast` | Formatting-preserving code printer (used by jscodeshift) |
| `simple-git` | Git operations for cloning, worktrees, and patch generation |

### Backend
| Package | Purpose |
|---|---|
| `fastify` | API server for the review UI |
| `@fastify/cors` | CORS support for frontend ↔ backend dev |
| `better-sqlite3` | SQLite access layer |

### Frontend
| Package | Purpose |
|---|---|
| `@tanstack/react-start` | Full-stack React framework (SSR + routing) |
| `@tanstack/react-router` | File-based routing |
| `@tanstack/react-query` | Data fetching and cache management |
| `react` / `react-dom` | UI library |
| `tailwindcss` | Utility-first CSS |
| `lucide-react` | Icons |

### Dev Tools
| Package | Purpose |
|---|---|
| `typescript` | Type checking |
| `vite` | Build tool and dev server |
| `vitest` | Test runner |
| `tsx` | TypeScript execution for CLI and backend |
| `concurrently` | Run frontend + backend in parallel |

## Quality Tools (planned)
- ESLint
- Biome
- Playwright (e2e)
- Knip (dead code detection)
