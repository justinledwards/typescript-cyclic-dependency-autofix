import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { type FindingRecord, type FindingsFilters, fetchFindings, fetchRepositories } from '../lib/api';

type QueueFilters = {
  repository_id: string;
  search: string;
  classification: string;
  validation_status: string;
  review_status: string;
  cycle_size: string;
};

const INITIAL_FILTERS: QueueFilters = {
  repository_id: 'all',
  search: '',
  classification: 'all',
  validation_status: 'all',
  review_status: 'all',
  cycle_size: 'all',
};

const CLASSIFICATION_OPTIONS = [
  ['all', 'All classifications'],
  ['autofix_extract_shared', 'Extract shared'],
  ['autofix_direct_import', 'Direct import'],
  ['autofix_import_type', 'Import type'],
  ['suggest_manual', 'Suggest manual'],
  ['unsupported', 'Unsupported'],
  ['unclassified', 'Unclassified'],
] as const;

const VALIDATION_OPTIONS = [
  ['all', 'All validation states'],
  ['pending', 'Pending'],
  ['passed', 'Passed'],
  ['failed', 'Failed'],
] as const;

const REVIEW_OPTIONS = [
  ['all', 'All review states'],
  ['pending', 'Pending'],
  ['approved', 'Approved'],
  ['pr_candidate', 'PR candidate'],
  ['ignored', 'Ignored'],
  ['rejected', 'Rejected'],
] as const;

const CYCLE_SIZE_OPTIONS = [
  ['all', 'Any size'],
  ['2', '2 files'],
  ['3', '3 files'],
  ['4', '4 files'],
  ['5', '5 files'],
] as const;

export const Route = createFileRoute('/findings')({
  component: FindingsQueue,
});

function FindingsQueue() {
  const [filters, setFilters] = useState<QueueFilters>(INITIAL_FILTERS);

  const { data: repositories = [] } = useQuery({
    queryKey: ['repositories'],
    queryFn: fetchRepositories,
  });

  const {
    data: findings = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['findings', filters],
    queryFn: () => fetchFindings(buildApiFilters(filters)),
  });

  const activeFilterCount = Object.entries(filters).filter(([key, value]) => {
    if (key === 'search') {
      return value.trim().length > 0;
    }
    return value !== 'all';
  }).length;

  return (
    <div className="page-wrap px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-8 flex flex-col gap-4 border-b border-[var(--line)] pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--sea-ink-soft)]">Review Queue</p>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--sea-ink)] sm:text-4xl">Findings queue</h1>
          <p className="max-w-3xl text-sm leading-6 text-[var(--sea-ink-soft)] sm:text-base">
            Narrow the latest findings by repository, classification, validation state, cycle size, and review status
            before opening a cycle for manual review.
          </p>
        </div>

        <Link
          to="/"
          className="inline-flex items-center justify-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)] no-underline transition hover:translate-y-[-1px] hover:shadow-[0_12px_24px_rgba(30,90,72,0.12)]"
        >
          Repositories
        </Link>
      </div>

      <div className="mb-6 rounded-3xl border border-[var(--line)] bg-[var(--panel-bg)] p-4 shadow-[0_16px_50px_rgba(27,67,54,0.08)] sm:p-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink-soft)]">
            <span>Search</span>
            <input
              value={filters.search}
              onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
              placeholder="Repo or cycle path"
              className="w-full rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--sea-ink)] outline-none transition placeholder:text-[var(--sea-ink-soft)] focus:border-[var(--lagoon)]"
            />
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink-soft)]">
            <span>Repository</span>
            <select
              value={filters.repository_id}
              onChange={(event) => setFilters((current) => ({ ...current, repository_id: event.target.value }))}
              className="w-full rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--sea-ink)] outline-none transition focus:border-[var(--lagoon)]"
            >
              <option value="all">All repositories</option>
              {repositories.map((repository: { id: number; owner: string; name: string }) => (
                <option key={repository.id} value={repository.id}>
                  {repository.owner}/{repository.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink-soft)]">
            <span>Classification</span>
            <select
              value={filters.classification}
              onChange={(event) => setFilters((current) => ({ ...current, classification: event.target.value }))}
              className="w-full rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--sea-ink)] outline-none transition focus:border-[var(--lagoon)]"
            >
              {CLASSIFICATION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink-soft)]">
            <span>Validation</span>
            <select
              value={filters.validation_status}
              onChange={(event) => setFilters((current) => ({ ...current, validation_status: event.target.value }))}
              className="w-full rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--sea-ink)] outline-none transition focus:border-[var(--lagoon)]"
            >
              {VALIDATION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink-soft)]">
            <span>Review</span>
            <select
              value={filters.review_status}
              onChange={(event) => setFilters((current) => ({ ...current, review_status: event.target.value }))}
              className="w-full rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--sea-ink)] outline-none transition focus:border-[var(--lagoon)]"
            >
              {REVIEW_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink-soft)]">
            <span>Cycle size</span>
            <select
              value={filters.cycle_size}
              onChange={(event) => setFilters((current) => ({ ...current, cycle_size: event.target.value }))}
              className="w-full rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--sea-ink)] outline-none transition focus:border-[var(--lagoon)]"
            >
              {CYCLE_SIZE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[var(--sea-ink-soft)]">{getActiveFilterMessage(activeFilterCount)}</p>
          <button
            type="button"
            onClick={() => setFilters(INITIAL_FILTERS)}
            className="rounded-full border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-sm font-medium text-[var(--sea-ink)] transition hover:border-[var(--lagoon)]"
          >
            Reset filters
          </button>
        </div>
      </div>

      {isLoading && (
        <div className="rounded-3xl border border-[var(--line)] bg-[var(--panel-bg)] p-8 text-[var(--sea-ink-soft)]">
          Loading findings...
        </div>
      )}

      {error && (
        <div className="rounded-3xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
          Error loading findings queue.
        </div>
      )}

      {!isLoading && !error && findings.length === 0 && (
        <div className="rounded-3xl border border-[var(--line)] bg-[var(--panel-bg)] p-8 text-[var(--sea-ink-soft)]">
          No findings match the current filters.
        </div>
      )}

      {!isLoading && !error && findings.length > 0 && (
        <div className="overflow-hidden rounded-3xl border border-[var(--line)] bg-[var(--panel-bg)] shadow-[0_16px_50px_rgba(27,67,54,0.08)]">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-[var(--line)]">
              <thead className="bg-[var(--surface)]/90">
                <tr className="text-left text-xs font-semibold uppercase tracking-[0.2em] text-[var(--sea-ink-soft)]">
                  <th className="px-5 py-4">Repository</th>
                  <th className="px-5 py-4">Cycle</th>
                  <th className="px-5 py-4">Classification</th>
                  <th className="px-5 py-4">Validation</th>
                  <th className="px-5 py-4">Review</th>
                  <th className="px-5 py-4">Confidence</th>
                  <th className="px-5 py-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)]">
                {findings.map((finding: FindingRecord) => (
                  <tr
                    key={`${finding.repository_id}-${finding.cycle_id}`}
                    className="align-top transition hover:bg-[var(--surface)]/70"
                  >
                    <td className="px-5 py-4 text-sm">
                      <div className="font-semibold text-[var(--sea-ink)]">
                        {finding.owner}/{finding.name}
                      </div>
                      <div className="text-xs text-[var(--sea-ink-soft)]">Scan {finding.scan_id}</div>
                    </td>
                    <td className="px-5 py-4 text-sm text-[var(--sea-ink)]">
                      <div className="font-mono text-xs leading-5 text-[var(--sea-ink)]">
                        {finding.cycle_path.length > 0 ? finding.cycle_path.join(' → ') : 'Unknown'}
                      </div>
                      <div className="mt-2 text-xs text-[var(--sea-ink-soft)]">Size {finding.cycle_size}</div>
                    </td>
                    <td className="px-5 py-4 text-sm">
                      <span className="inline-flex rounded-full bg-[var(--chip-bg)] px-3 py-1 text-xs font-semibold text-[var(--sea-ink)]">
                        {finding.classification || 'unclassified'}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm">
                      <div className={statusBadgeClass(finding.validation_status)}>{finding.validation_status}</div>
                      {finding.validation_summary && (
                        <p className="mt-2 max-w-sm text-xs leading-5 text-[var(--sea-ink-soft)]">
                          {finding.validation_summary}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-4 text-sm">
                      <div className={statusBadgeClass(finding.review_status)}>{finding.review_status}</div>
                      {finding.review_notes && (
                        <p className="mt-2 max-w-sm text-xs leading-5 text-[var(--sea-ink-soft)]">
                          {finding.review_notes}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-4 text-sm text-[var(--sea-ink)]">
                      {finding.confidence === null ? 'N/A' : `${Math.round(finding.confidence * 100)}%`}
                    </td>
                    <td className="px-5 py-4 text-right text-sm font-medium">
                      <Link
                        to="/repositories/$id/cycles/$cycleId"
                        params={{ id: String(finding.repository_id), cycleId: String(finding.cycle_id) }}
                        className="inline-flex rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--sea-ink)] no-underline transition hover:border-[var(--lagoon)] hover:text-[var(--lagoon)]"
                      >
                        Review
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function buildApiFilters(filters: QueueFilters): FindingsFilters {
  return {
    repository_id: filters.repository_id,
    search: filters.search,
    classification: filters.classification,
    validation_status: filters.validation_status,
    review_status: filters.review_status,
    cycle_size: filters.cycle_size,
  };
}

function getActiveFilterMessage(activeFilterCount: number): string {
  if (activeFilterCount === 0) {
    return 'Showing the latest findings for all repositories.';
  }

  const suffix = activeFilterCount === 1 ? '' : 's';
  return `Showing ${activeFilterCount} active filter${suffix}.`;
}

function statusBadgeClass(status: string) {
  if (status === 'passed' || status === 'approved') {
    return 'inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-800';
  }

  if (status === 'failed' || status === 'rejected') {
    return 'inline-flex rounded-full bg-rose-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-rose-800';
  }

  if (status === 'pr_candidate' || status === 'pending') {
    return 'inline-flex rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-amber-800';
  }

  return 'inline-flex rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-slate-700';
}
