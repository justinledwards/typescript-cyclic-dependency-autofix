import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  type CycleDetailCandidateRecord,
  fetchCycleDetail,
  type ReviewDecision,
  submitReviewDecision,
} from '../lib/api';

type CycleDetailData = Awaited<ReturnType<typeof fetchCycleDetail>>;

export const Route = createFileRoute('/repositories/$id/cycles/$cycleId')({
  component: CycleDetail,
});

function CycleDetail() {
  const { id, cycleId } = Route.useParams();
  const queryClient = useQueryClient();
  const [selectedCandidateId, setSelectedCandidateId] = useState<number | null>(null);

  const {
    data: cycle,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['cycle', id, cycleId],
    queryFn: () => fetchCycleDetail(id, cycleId),
  });

  useEffect(() => {
    if (!cycle?.candidates?.length) {
      setSelectedCandidateId(null);
      return;
    }

    if (selectedCandidateId && cycle.candidates.some((candidate) => candidate.id === selectedCandidateId)) {
      return;
    }

    setSelectedCandidateId(cycle.candidates[0].id);
  }, [cycle?.candidates, selectedCandidateId]);

  const selectedCandidate =
    cycle?.candidates.find((candidate) => candidate.id === selectedCandidateId) ?? cycle?.candidates[0] ?? null;

  const reviewMutation = useMutation({
    mutationFn: (decision: ReviewDecision) => {
      if (!selectedCandidate?.patch_id) {
        throw new Error('No patch is available for this cycle.');
      }

      return submitReviewDecision(String(selectedCandidate.patch_id), decision);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['cycle', id, cycleId] }),
        queryClient.invalidateQueries({ queryKey: ['findings'] }),
      ]);
    },
  });

  if (isLoading) return <div className="p-8">Loading cycle details...</div>;
  if (error) return <div className="p-8 text-red-600">Error loading cycle details</div>;

  const statusColor = getValidationStatusColor(selectedCandidate?.validation_status ?? cycle?.validation_status);
  const canReview = Boolean(selectedCandidate?.patch_id);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <Link to="/repositories/$id" params={{ id }} className="text-blue-600 hover:underline mb-4 inline-block">
          &larr; Back to Findings
        </Link>
        <h1 className="text-3xl font-bold">Cycle Review</h1>
      </div>

      {cycle && (
        <div className="space-y-6">
          <CycleDetailsSection cycle={cycle} />
          {cycle.candidates.length > 1 ? (
            <CandidateSelectorSection
              candidates={cycle.candidates}
              selectedCandidateId={selectedCandidate?.id ?? null}
              onSelect={setSelectedCandidateId}
            />
          ) : null}
          <CandidateAnalysisSection candidate={selectedCandidate} />
          <DependencySummarySection cycle={cycle} candidate={selectedCandidate} statusColor={statusColor} />
          <ReplayProvenanceSection candidate={selectedCandidate} statusColor={statusColor} />
          <PatchSection candidate={selectedCandidate} />

          <div className="flex gap-4 justify-end">
            <button
              type="button"
              disabled={!canReview || reviewMutation.isPending}
              onClick={() => reviewMutation.mutate('rejected')}
              className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors disabled:cursor-not-allowed disabled:bg-red-300"
            >
              Reject
            </button>
            <button
              type="button"
              disabled={!canReview || reviewMutation.isPending}
              onClick={() => reviewMutation.mutate('ignored')}
              className="px-6 py-2 bg-slate-700 text-white rounded-md hover:bg-slate-800 transition-colors disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Ignore
            </button>
            <button
              type="button"
              disabled={!canReview || reviewMutation.isPending}
              onClick={() => reviewMutation.mutate('pr_candidate')}
              className="px-6 py-2 bg-amber-600 text-white rounded-md hover:bg-amber-700 transition-colors disabled:cursor-not-allowed disabled:bg-amber-300"
            >
              PR Candidate
            </button>
            <button
              type="button"
              disabled={!canReview || reviewMutation.isPending}
              onClick={() => reviewMutation.mutate('approved')}
              className="px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:cursor-not-allowed disabled:bg-green-300"
            >
              Approve
            </button>
          </div>
          {!canReview && (
            <p className="text-right text-sm text-gray-500">
              A patch must exist before a review decision can be recorded.
            </p>
          )}
          {reviewMutation.isPending && <p className="text-right text-sm text-gray-500">Saving review decision...</p>}
        </div>
      )}
    </div>
  );
}

function CycleDetailsSection({ cycle }: { cycle: CycleDetailData }) {
  const cyclePath = Array.isArray(cycle.cycle_path) ? cycle.cycle_path.join(' → ') : 'No path available';
  const confidence = typeof cycle.confidence === 'number' ? `${(Number(cycle.confidence) * 100).toFixed(0)}%` : 'N/A';
  const totalCandidates = cycle.candidates.length;

  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
      <h2 className="text-xl font-semibold mb-4">Details</h2>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="text-gray-500 block text-sm">Primary classification</span>
          <span className="font-medium bg-gray-100 px-2 py-1 rounded-md mt-1 inline-block">
            {String(cycle.classification || 'Unknown')}
          </span>
        </div>
        <div>
          <span className="text-gray-500 block text-sm">Primary confidence</span>
          <span className="font-medium">{confidence}</span>
        </div>
        <div>
          <span className="text-gray-500 block text-sm">Candidate count</span>
          <span className="font-medium">{totalCandidates}</span>
        </div>
        <div>
          <span className="text-gray-500 block text-sm">Primary review status</span>
          <span className="font-medium bg-gray-100 px-2 py-1 rounded-md mt-1 inline-block">
            {String(cycle.review_status || 'pending')}
          </span>
          {cycle.review_notes && <p className="mt-2 text-sm text-gray-500">{cycle.review_notes}</p>}
        </div>
        <div className="col-span-2">
          <span className="text-gray-500 block text-sm">Cycle Path</span>
          <div className="bg-gray-50 p-3 rounded-md mt-1 font-mono text-sm break-all">{cyclePath}</div>
        </div>
      </div>
    </div>
  );
}

function CandidateSelectorSection({
  candidates,
  selectedCandidateId,
  onSelect,
}: {
  candidates: CycleDetailCandidateRecord[];
  selectedCandidateId: number | null;
  onSelect: (candidateId: number) => void;
}) {
  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
      <h2 className="text-xl font-semibold mb-4">Candidate Shortlist</h2>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {candidates.map((candidate) => {
          const isSelected = candidate.id === selectedCandidateId;
          const upstreamability =
            typeof candidate.upstreamability_score === 'number'
              ? `${Math.round(candidate.upstreamability_score * 100)}%`
              : 'N/A';

          return (
            <button
              key={candidate.id}
              type="button"
              onClick={() => onSelect(candidate.id)}
              className={`rounded-lg border p-4 text-left transition ${
                isSelected ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Rank {candidate.planner_rank}
                  </p>
                  <p className="mt-1 font-medium text-gray-900">{candidate.classification}</p>
                </div>
                <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
                  {upstreamability}
                </span>
              </div>
              <div className="mt-3 space-y-1 text-sm text-gray-600">
                <p>Strategy: {candidate.strategy || 'fallback'}</p>
                <p>Confidence: {Math.round(candidate.confidence * 100)}%</p>
                <p>Validation: {candidate.validation_status || 'pending'}</p>
                <p>Review: {candidate.review_status || 'pending'}</p>
              </div>
              {candidate.summary ? <p className="mt-3 text-sm text-gray-500">{candidate.summary}</p> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CandidateAnalysisSection({ candidate }: { candidate: CycleDetailCandidateRecord | null }) {
  const upstreamability =
    typeof candidate?.upstreamability_score === 'number'
      ? `${Math.round(candidate.upstreamability_score * 100)}%`
      : 'N/A';

  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
      <h2 className="text-xl font-semibold mb-4">Selected Candidate</h2>
      {candidate ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <MetadataField label="Strategy" value={candidate.strategy || 'fallback'} />
            <MetadataField label="Planner rank" value={String(candidate.planner_rank)} />
            <MetadataField label="Upstreamability" value={upstreamability} />
          </div>

          <div>
            <span className="text-gray-500 block text-sm mb-2">Reasons</span>
            {candidate.reasons && candidate.reasons.length > 0 ? (
              <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
                {candidate.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500 italic">No candidate reasons were recorded.</p>
            )}
          </div>

          <div>
            <span className="text-gray-500 block text-sm mb-2">Score breakdown</span>
            {candidate.score_breakdown.length > 0 ? (
              <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
                {candidate.score_breakdown.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500 italic">No score breakdown was recorded.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-500 italic">No persisted candidate is available for this cycle yet.</p>
      )}
    </div>
  );
}

function DependencySummarySection({
  cycle,
  candidate,
  statusColor,
}: {
  cycle: CycleDetailData;
  candidate: CycleDetailCandidateRecord | null;
  statusColor: string;
}) {
  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
      <h2 className="text-xl font-semibold mb-4">Dependency Summary</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Before (Original Cycle)</h3>
          {cycle.raw_payload ? (
            <pre className="bg-gray-50 p-4 rounded-md overflow-x-auto text-xs font-mono border border-gray-200 h-64 overflow-y-auto">
              <code>{JSON.stringify(cycle.raw_payload, null, 2)}</code>
            </pre>
          ) : (
            <p className="text-gray-500 italic text-sm">No raw payload available.</p>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">After (Validation)</h3>
          <div className="mb-2">
            <span className="text-gray-500 text-sm">Status: </span>
            <span className={`font-medium ${statusColor}`}>{candidate?.validation_status || 'Pending / N/A'}</span>
          </div>
          {candidate?.validation_summary ? (
            <pre className="bg-gray-50 p-4 rounded-md overflow-x-auto text-xs font-mono border border-gray-200 h-56 overflow-y-auto w-full">
              <code>{candidate.validation_summary}</code>
            </pre>
          ) : (
            <p className="text-gray-500 italic text-sm mt-4">No validation summary available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ReplayProvenanceSection({
  candidate,
  statusColor,
}: {
  candidate: CycleDetailCandidateRecord | null;
  statusColor: string;
}) {
  const replay = candidate?.replay;
  const repositoryLabel =
    replay?.repository?.owner && replay.repository.name
      ? `${replay.repository.owner}/${replay.repository.name}`
      : 'N/A';
  const fileSnapshotCount = replay?.file_snapshots?.length || 0;

  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
      <h2 className="text-xl font-semibold mb-4">Replay Provenance</h2>
      {replay ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <MetadataField label="Source Target" value={replay.source_target || 'N/A'} breakAll />
            <MetadataField label="Commit SHA" value={replay.commit_sha || 'N/A'} mono breakAll />
            <MetadataField label="Repository" value={repositoryLabel} />
            <MetadataField label="Repository Path" value={replay.repository?.local_path || 'N/A'} breakAll />
            <MetadataField label="Classification" value={replay.candidate?.classification || 'Unknown'} />
            <div>
              <span className="text-gray-500 block text-sm">Validation</span>
              <span className={`font-medium ${statusColor}`}>{replay.validation?.status || 'Pending / N/A'}</span>
            </div>
          </div>

          <div>
            <span className="text-gray-500 block text-sm mb-2">File Snapshots ({fileSnapshotCount})</span>
            {replay.file_snapshots?.length ? (
              <pre className="bg-gray-50 p-4 rounded-md overflow-x-auto text-xs font-mono border border-gray-200 max-h-72 overflow-y-auto">
                <code>{JSON.stringify(replay.file_snapshots, null, 2)}</code>
              </pre>
            ) : (
              <p className="text-gray-500 italic text-sm">No file snapshots available.</p>
            )}
          </div>

          {replay.validation?.summary ? (
            <div>
              <span className="text-gray-500 block text-sm mb-2">Validation Summary</span>
              <pre className="bg-gray-50 p-4 rounded-md overflow-x-auto text-xs font-mono border border-gray-200 max-h-56 overflow-y-auto">
                <code>{replay.validation.summary}</code>
              </pre>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-gray-500 italic text-sm">No replay bundle stored for this patch yet.</p>
      )}
    </div>
  );
}

function PatchSection({ candidate }: { candidate: CycleDetailCandidateRecord | null }) {
  return (
    <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
      <h2 className="text-xl font-semibold mb-4">Proposed Patch</h2>
      {candidate?.patch ? (
        <pre className="bg-gray-50 p-4 rounded-md overflow-x-auto text-sm font-mono border border-gray-200">
          <code>{candidate.patch}</code>
        </pre>
      ) : (
        <p className="text-gray-500 italic">No patch available for this cycle.</p>
      )}
    </div>
  );
}

function MetadataField({
  label,
  value,
  mono = false,
  breakAll = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  breakAll?: boolean;
}) {
  const className = ['font-medium', mono ? 'font-mono' : '', breakAll ? 'break-all' : ''].filter(Boolean).join(' ');

  return (
    <div>
      <span className="text-gray-500 block text-sm">{label}</span>
      <span className={className}>{value}</span>
    </div>
  );
}

function getValidationStatusColor(validationStatus: string | null | undefined): string {
  if (validationStatus === 'passed') {
    return 'text-green-600';
  }

  if (validationStatus === 'failed') {
    return 'text-red-600';
  }

  return 'text-gray-800';
}
