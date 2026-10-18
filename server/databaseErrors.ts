export class DatabaseError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

export type MaybePromise<T> = T | Promise<T>
