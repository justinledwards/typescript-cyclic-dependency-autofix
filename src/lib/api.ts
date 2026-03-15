const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

export async function fetchRepositories() {
  const response = await fetch(`${API_BASE_URL}/repositories`);
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  return response.json();
}

export async function fetchRepository(id: string) {
  const response = await fetch(`${API_BASE_URL}/repositories/${id}`);
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  return response.json();
}

export async function fetchRepositoryFindings(id: string, filters?: Record<string, unknown>) {
  const url = new URL(`${API_BASE_URL}/repositories/${id}/findings`);
  if (filters) {
    Object.keys(filters).forEach(key => {
      if (filters[key] !== undefined && filters[key] !== null) {
        url.searchParams.append(key, String(filters[key]));
      }
    });
  }
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  return response.json();
}

export async function fetchCycleDetail(repoId: string, cycleId: string) {
  const response = await fetch(`${API_BASE_URL}/repositories/${repoId}/cycles/${cycleId}`);
  if (!response.ok) {
    throw new Error('Network response was not ok');
  }
  return response.json();
}
