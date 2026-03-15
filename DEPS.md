mise-en-place

tools:
ESLint
dependency-cruiser
Biome
TypeScript
Vitest
Playwright
Knip
jscpd
husky
lint-staged
eslint-plugin-sonarjs
eslint-plugin-unicorn
@tanstack/eslint-config

Repo-specific quality scripts:
validate-planner-profiles
audit-planner-governance
guard-plan-runtime-boundaries
guard-max-lines
docs-link-audit
workflow-sanity
ci-changed-scope
test-lanes runner


```linux.sh
sudo apt update
sudo apt install -y \
  git \
  curl \
  jq \
  unzip \
  sqlite3 \
  build-essential \
  python3 \
  ca-certificates
```

```mac.sh
brew install \
  git \
  jq \
  sqlite \
  python \
  node \
  pnpm
```


