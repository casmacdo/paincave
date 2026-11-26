// Cloudflare Worker entrypoint — populated in M2-01
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "paincave-worker" });
    }
    return Response.json({ error: "Not implemented yet (complete M2-01)" }, { status: 501 });
  },
};
