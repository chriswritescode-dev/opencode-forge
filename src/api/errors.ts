export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

export const badRequest = (msg: string) =>
  new ApiError(400, 'bad_request', msg)
export const unauthorized = () =>
  new ApiError(401, 'unauthorized', 'missing or invalid credentials')
export const forbidden = (msg = 'forbidden') =>
  new ApiError(403, 'forbidden', msg)
export const notFound = (msg = 'not found') =>
  new ApiError(404, 'not_found', msg)
export const conflict = (msg: string) =>
  new ApiError(409, 'conflict', msg)
