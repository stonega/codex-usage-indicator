// Dependencies are passed in by the GJS entrypoint; this keeps account/cleanup
// behavior testable without a real token or a live API request.
export async function fetchPanelSummary(options, loadAuth, createClient) {
    const auth = await loadAuth(options.authFile ? {path: options.authFile} : {});
    const client = createClient();
    try {
        return await client.fetchSummary(auth.accessToken, auth.accountId);
    } finally {
        client.destroy();
    }
}
