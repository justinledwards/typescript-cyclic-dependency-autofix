import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { fetchRepository, fetchRepositoryFindings } from '../lib/api';

export const Route = createFileRoute('/repositories/$id/')({
  component: RepositoryFindings,
});

function RepositoryFindings() {
  const { id } = Route.useParams();
  const [filter, setFilter] = useState<string>('all');

  const { data: repository, isLoading: repoLoading } = useQuery({
    queryKey: ['repository', id],
    queryFn: () => fetchRepository(id),
  });

  const {
    data: findings,
    isLoading: findingsLoading,
    error,
  } = useQuery({
    queryKey: ['findings', id, filter],
    queryFn: () => fetchRepositoryFindings(id, filter === 'all' ? undefined : { status: filter }),
  });

  if (repoLoading || findingsLoading) return <div className="p-8">Loading...</div>;

  if (error) return <div className="p-8 text-red-600">Error loading findings</div>;

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-8">
        <Link to="/" className="text-blue-600 hover:underline mb-4 inline-block">
          &larr; Back to Repositories
        </Link>
        <h1 className="text-3xl font-bold">{repository?.name || 'Repository Findings'}</h1>
      </div>

      <div className="mb-6 flex gap-4 items-center">
        <label htmlFor="filterStatus" className="font-medium text-gray-700">
          Filter Status:
        </label>
        <select
          id="filterStatus"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="border border-gray-300 rounded-md p-2 bg-white"
        >
          <option value="all">All</option>
          <option value="pending">Pending</option>
          <option value="reviewed">Reviewed</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Cycle Path
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Classification
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Confidence
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {findings?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-6 py-4 text-center text-gray-500">
                  No findings match this filter.
                </td>
              </tr>
            )}
            {findings?.map((finding: Record<string, unknown>) => (
              <tr key={String(finding.id)} className="hover:bg-gray-50">
                <td className="px-6 py-4 text-sm text-gray-900 break-words max-w-md">
                  {finding.cycle_path ? (finding.cycle_path as string[]).join(' → ') : 'Unknown'}
                </td>
                <td className="px-6 py-4 text-sm text-gray-500">
                  <span className="px-2 py-1 bg-gray-100 rounded-full text-xs font-medium">
                    {String(finding.classification || 'unclassified')}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm text-gray-500">
                  {finding.confidence ? `${Math.round(Number(finding.confidence) * 100)}%` : '-'}
                </td>
                <td className="px-6 py-4 text-sm text-gray-500">
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-medium ${(() => {
                      if (finding.status === 'approved') return 'bg-green-100 text-green-800';
                      if (finding.status === 'rejected') return 'bg-red-100 text-red-800';
                      return 'bg-yellow-100 text-yellow-800';
                    })()}`}
                  >
                    {String(finding.status || 'pending')}
                  </span>
                </td>
                <td className="px-6 py-4 text-right text-sm font-medium">
                  <Link
                    to="/repositories/$id/cycles/$cycleId"
                    params={{ id, cycleId: String(finding.id) }}
                    className="text-blue-600 hover:text-blue-900"
                  >
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
