interface Env {
  BACKEND: Fetcher;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url);
  const backendUrl = new URL(url.pathname + url.search, "https://backend");
  return context.env.BACKEND.fetch(backendUrl.toString(), context.request);
};
