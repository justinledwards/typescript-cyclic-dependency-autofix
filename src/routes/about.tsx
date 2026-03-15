import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/about')({
  component: About,
});

function About() {
  return (
    <div className="p-8 max-w-4xl mx-auto rise-in">
      <h1 className="text-3xl font-bold mb-6">About</h1>

      <div className="island-shell rounded-2xl p-8 space-y-6">
        <section>
          <h2 className="text-xl font-semibold mb-3">What is this?</h2>
          <p className="text-[var(--sea-ink-soft)] leading-relaxed">
            The Circular Dependency Autofix Bot scans JavaScript and TypeScript repositories for circular dependencies,
            classifies which cycles are safe to fix automatically, generates patch files for those fixes, and provides a
            review UI so a human can inspect candidates before they become pull requests.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">How it works</h2>
          <ol className="list-decimal list-inside space-y-2 text-[var(--sea-ink-soft)]">
            <li>Clone or update repository heads</li>
            <li>
              Run <code>dependency-cruiser</code> to detect circular dependencies
            </li>
            <li>Classify each cycle: auto-fixable, suggest-only, or unsupported</li>
            <li>
              Generate patch files for high-confidence cases using <code>jscodeshift</code>
            </li>
            <li>
              Validate with <code>tsc --noEmit</code> and re-run cycle detection
            </li>
            <li>Present findings in this review UI for triage</li>
          </ol>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">Safe auto-fix scope</h2>
          <p className="text-[var(--sea-ink-soft)] leading-relaxed">
            The first release only auto-fixes cycles that involve two files with safe top-level declarations (named
            functions, consts, type aliases, interfaces). No classes, no default exports, no side-effects. Conservative
            and repeatable.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-3">Tech stack</h2>
          <ul className="grid grid-cols-2 gap-2 text-[var(--sea-ink-soft)]">
            <li>
              <strong>Frontend:</strong> TanStack Start + React
            </li>
            <li>
              <strong>Backend:</strong> Fastify
            </li>
            <li>
              <strong>Database:</strong> SQLite (better-sqlite3)
            </li>
            <li>
              <strong>Analysis:</strong> dependency-cruiser + ts-morph
            </li>
            <li>
              <strong>Codemods:</strong> jscodeshift + recast
            </li>
            <li>
              <strong>Language:</strong> TypeScript
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
