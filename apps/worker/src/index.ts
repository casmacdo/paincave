export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "paincave-worker" });
    }
    return Response.json({ error: "Not implemented yet (complete M2-01)" }, { status: 501 });
  },
};
