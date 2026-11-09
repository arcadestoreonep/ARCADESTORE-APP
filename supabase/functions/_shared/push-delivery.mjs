export async function deliverWithRetryAndCleanup(subscription, send, remove, wait = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await send(subscription); return 'sent'; }
    catch (error) {
      const status = Number(error?.statusCode || error?.status || 0);
      if (status === 404 || status === 410) { await remove(subscription.id); return 'gone'; }
      if (status === 429 || status >= 500 || status === 0) {
        if (attempt < 2) { await wait(attempt === 0 ? 350 : 900); continue; }
      }
      return 'failed';
    }
  }
  return 'failed';
}
