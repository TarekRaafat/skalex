export interface SkalexConfig {
  path?: string;
  format?: 'gz' | 'json';
}

export interface FindOptions {
  populate?: string[];
  select?: string[];
  sort?: { [field: string]: 1 | -1 };
  page?: number;
  limit?: number;
}

export interface FindResult<T = Record<string, unknown>> {
  docs: T[];
  page?: number;
  totalDocs?: number;
  totalPages?: number;
}

export interface SingleResult<T = Record<string, unknown>> {
  data: T;
}

export interface ManyResult<T = Record<string, unknown>> {
  docs: T[];
}

export interface ExportOptions {
  dir?: string;
  name?: string;
  format?: 'json' | 'csv';
}

export declare class Collection<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly name: string;

  insertOne(item: Partial<T>, options?: { save?: boolean }): Promise<SingleResult<T>>;
  insertMany(items: Partial<T>[], options?: { save?: boolean }): Promise<ManyResult<T>>;

  findOne(filter: Partial<T> | Record<string, unknown>, options?: FindOptions): Promise<T | null>;
  find(filter: Partial<T> | Record<string, unknown>, options?: FindOptions): Promise<FindResult<T>>;

  updateOne(filter: Partial<T> | Record<string, unknown>, update: Record<string, unknown>, options?: { save?: boolean }): Promise<SingleResult<T> | null>;
  updateMany(filter: Partial<T> | Record<string, unknown>, update: Record<string, unknown>, options?: { save?: boolean }): Promise<ManyResult<T>>;

  deleteOne(filter: Partial<T> | Record<string, unknown>, options?: { save?: boolean }): Promise<SingleResult<T> | null>;
  deleteMany(filter: Partial<T> | Record<string, unknown>, options?: { save?: boolean }): Promise<ManyResult<T>>;

  export(filter?: Partial<T> | Record<string, unknown>, options?: ExportOptions): Promise<void>;
}

export declare class Skalex {
  constructor(config?: SkalexConfig);

  readonly dataDirectory: string;
  readonly isConnected: boolean;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  useCollection<T extends Record<string, unknown> = Record<string, unknown>>(name: string): Collection<T>;
  saveData(collectionName?: string): Promise<void>;
}

export default Skalex;
