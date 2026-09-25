/** Throw from anywhere in a request; the app error handler maps it to JSON. */
export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 502,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "资源") => new HttpError(404, `${what}不存在`, "not_found");
