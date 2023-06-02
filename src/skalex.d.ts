declare module 'skalex' {
    import { WriteStream } from 'fs';

    interface SkalexOptions {
        dataDirectory: string;
    }

    interface CollectionData {
        collectionName: string;
        data: object[];
        index: Map<string, object>;
    }

    interface InsertRecord {
        data: object | object[];
        save: () => Promise<void>;
    }

    interface UpdateRecord {
        data: object | object[];
        save: () => Promise<void>;
    }

    interface DeleteRecord {
        data: object | object[];
        save: () => Promise<void>;
    }

    class Collection {
        constructor(collectionData: CollectionData, database: Skalex);

        name: string;
        data: object[];
        index: Map<string, object>;
        database: Skalex;

        insertOne(item: object): InsertRecord;
        insertMany(items: object[]): InsertRecord;
        updateOne(filter: object, update: object): UpdateRecord | null;
        updateMany(filter: object, update: object): UpdateRecord | [];
        findOne(filter: object): object | null;
        find(filter: object, options?: FindOptions): object[];
        deleteOne(filter: object): DeleteRecord | null;
        deleteMany(filter: object): DeleteRecord | [];
        matchesFilter(item: object, filter: object): boolean;
        findIndex(filter: object): number;
        exportToCSV(filter?: object): void;
    }

    interface FindOptions {
        populate?: string[];
        select?: string[];
    }

    class Skalex {
        constructor(dataDirectory: string);

        dataDirectory: string;
        collections: { [key: string]: CollectionData };
        isConnected: boolean;

        connect(): Promise<void>;
        disconnect(): Promise<void>;
        useCollection(collectionName: string): Collection;
        createCollection(collectionName: string): Collection;
        loadData(): Promise<void>;
        saveData(): Promise<void>;
        buildIndex(data: object[]): Map<string, object>;
    }

    export = Skalex;
}
