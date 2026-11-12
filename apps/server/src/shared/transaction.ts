import type { Prisma } from '../generated/prisma/client.js';

declare const opaque: unique symbol;

/**
 * An open database transaction, passed from one module to another so that a change and its audit
 * entry commit together (ADR-2). Services only hand it on; only repos look inside it, and each repo
 * still writes only its own tables.
 */
export type Transaction = { readonly [opaque]: true };

export const asTransaction = (tx: Prisma.TransactionClient): Transaction =>
  tx as unknown as Transaction;

/** For repos only. */
export const prismaOf = (tx: Transaction): Prisma.TransactionClient =>
  tx as unknown as Prisma.TransactionClient;
