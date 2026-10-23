const controller = new AbortController();

fetch('/api/data', { signal: controller.signal })
  .then((response) => response.json())
  .then((data) => setData(data))
  .catch((err) => {
    // Safely ignore expected cancellations
    if (err.name === 'AbortError') {
      console.log('Fetch aborted intentionally');
      return;
    }
    // Handle actual network/server errors here
    console.error('An actual error occurred:', err);
  });

// Later, or in a cleanup function:
controller.abort();
