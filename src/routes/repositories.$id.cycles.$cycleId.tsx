import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { fetchCycleDetail, type ReviewDecision, submitReviewDecision } from '../lib/api';

type ReplayBundle = {
  source_target?: string | null;
  commit_sha?: string | null;
  repository?: {
    owner?: string;
    name?: string;
    local_path?: string | null;
  };
  candidate?: {
    classification?: string;
    confidence?: number;
    reasons?: string[] | null;
  };
  validation?: {
    status?: string;
    summary?: string;
  };
  file_snapshots?: Array<{
    path: string;
    before: string;
    after: string;
  }>;
};

export const Route = createFileRoute('/repositories/$id/cycles/$cycleId')({
  component: CycleDetail,
});

function CycleDetail() {
  const { id, cycleId } = Route.useParams();
  const queryClient = useQueryClient();

  const {
    data: cycle,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['cycle', id, cycleId],
    queryFn: () => fetchCycleDetail(id, cycleId),
  });

  const reviewMutation = useMutation({
    mutationFn: (decision: ReviewDecision) => {
      if (!cycle?.patch_id) {
        throw new Error('No patch is available for this cycle.');
      }

      return submitReviewDecision(String(cycle.patch_id), decision);
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

  let statusColor = 'text-gray-800';
  if (cycle?.validation_status === 'passed') statusColor = 'text-green-600';
  if (cycle?.validation_status === 'failed') statusColor = 'text-red-600';
  const replay = cycle?.replay as ReplayBundle | null | undefined;

  const canReview = Boolean(cycle?.patch_id);

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
          <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
            <h2 className="text-xl font-semibold mb-4">Details</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <span className="text-gray-500 block text-sm">Classification</span>
                <span className="font-medium bg-gray-100 px-2 py-1 rounded-md mt-1 inline-block">
                  {String(cycle.classification || 'Unknown')}
                </span>
              </div>
              <div>
                <span className="text-gray-500 block text-sm">Confidence</span>
                <span className="font-medium">
                  {cycle.confidence ? `${(Number(cycle.confidence) * 100).toFixed(0)}%` : 'N/A'}
                </span>
              </div>
              <div>
                <span className="text-gray-500 block text-sm">Review Status</span>
                <span className="font-medium bg-gray-100 px-2 py-1 rounded-md mt-1 inline-block">
                  {String(cycle.review_status || 'pending')}
                </span>
                {cycle.review_notes && <p className="mt-2 text-sm text-gray-500">{cycle.review_notes}</p>}
              </div>
              <div className="col-span-2">
                <span className="text-gray-500 block text-sm">Cycle Path</span>
                <div className="bg-gray-50 p-3 rounded-md mt-1 font-mono text-sm break-all">
                  {cycle.cycle_path ? (cycle.cycle_path as string[]).join(' → ') : 'No path available'}
                </div>
              </div>
            </div>
          </div>

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
                  <span className={`font-medium ${statusColor}`}>{cycle.validation_status || 'Pending / N/A'}</span>
                </div>
                {cycle.validation_summary ? (
                  <pre className="bg-gray-50 p-4 rounded-md overflow-x-auto text-xs font-mono border border-gray-200 h-56 overflow-y-auto w-full">
                    <code>{cycle.validation_summary}</code>
                  </pre>
                ) : (
                  <p className="text-gray-500 italic text-sm mt-4">No validation summary available.</p>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
            <h2 className="text-xl font-semibold mb-4">Replay Provenance</h2>
            {replay ? (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <span className="text-gray-500 block text-sm">Source Target</span>
                    <span className="font-medium break-all">{replay.source_target || 'N/A'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block text-sm">Commit SHA</span>
                    <span className="font-medium font-mono break-all">{replay.commit_sha || 'N/A'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block text-sm">Repository</span>
                    <span className="font-medium">
                      {replay.repository?.owner && replay.repository?.name
                        ? `${replay.repository.owner}/${replay.repository.name}`
                        : 'N/A'}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500 block text-sm">Repository Path</span>
                    <span className="font-medium break-all">{replay.repository?.local_path || 'N/A'}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 block text-sm">Classification</span>
                    <span className="font-medium">
                      {replay.candidate?.classification || String(cycle.classification || 'Unknown')}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500 block text-sm">Validation</span>
                    <span className={`font-medium ${statusColor}`}>
                      {replay.validation?.status || cycle.validation_status || 'Pending / N/A'}
                    </span>
                  </div>
                </div>

                <div>
                  <span className="text-gray-500 block text-sm mb-2">
                    File Snapshots ({replay.file_snapshots?.length || 0})
                  </span>
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

          <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
            <h2 className="text-xl font-semibold mb-4">Proposed Patch</h2>
            {cycle.patch ? (
              <pre className="bg-gray-50 p-4 rounded-md overflow-x-auto text-sm font-mono border border-gray-200">
                <code>{cycle.patch}</code>
              </pre>
            ) : (
              <p className="text-gray-500 italic">No patch available for this cycle.</p>
            )}
          </div>

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
