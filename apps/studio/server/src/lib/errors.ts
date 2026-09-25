export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = "记录") => new HttpError(404, `${what}不存在`);
export const badRequest = (message: string) => new HttpError(400, message);
