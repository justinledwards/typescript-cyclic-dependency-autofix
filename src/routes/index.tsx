import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { fetchRepositories } from '../lib/api';

export const Route = createFileRoute('/')({
  component: RepositoriesList,
});

function RepositoriesList() {
  const {
    data: repositories,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['repositories'],
    queryFn: fetchRepositories,
  });

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Repositories</h1>

      {isLoading && <p className="text-gray-500">Loading repositories...</p>}

      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-md">
          <p>Error loading repositories: {error.message}</p>
        </div>
      )}

      {repositories && repositories.length === 0 && <p className="text-gray-500">No repositories found.</p>}

      {repositories && repositories.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {repositories.map(
            (repo: { id: number | string; name: string; owner?: string; last_scanned?: string; status?: string }) => (
              <Link
                key={repo.id}
                to="/repositories/$id"
                params={{ id: repo.id.toString() }}
                className="block p-6 bg-white border border-gray-200 rounded-lg shadow-sm hover:bg-gray-50 transition-colors"
              >
                <h2 className="text-xl font-semibold mb-2">{repo.name}</h2>
                {repo.owner && <p className="text-gray-600 text-sm mb-4">Owner: {repo.owner}</p>}

                <div className="flex gap-4 text-sm text-gray-500">
                  <span>{repo.last_scanned ? new Date(repo.last_scanned).toLocaleDateString() : 'Never scanned'}</span>
                  {repo.status && <span className="capitalize">{repo.status}</span>}
                </div>
              </Link>
            ),
          )}
        </div>
      )}
    </div>
  );
}
