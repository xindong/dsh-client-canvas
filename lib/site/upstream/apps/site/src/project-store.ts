import type { BoardDocument } from "@pixi-board/core";

export type SiteProject = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  document: BoardDocument;
};

const DB_NAME = "pixiboard-site-projects";
const DB_VERSION = 1;
const PROJECT_STORE = "projects";
const META_STORE = "meta";
const ACTIVE_PROJECT_KEY = "active-project-id";

export class SiteProjectStore {
  #database: Promise<IDBDatabase> | undefined;

  async list(): Promise<Array<Omit<SiteProject, "document">>> {
    const database = await this.database();
    const projects = await request<Array<SiteProject>>(database.transaction(PROJECT_STORE, "readonly").objectStore(PROJECT_STORE).getAll());
    return projects
      .map(({ document: _document, ...project }) => project)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async all(): Promise<SiteProject[]> {
    const database = await this.database();
    const projects = await request<SiteProject[]>(database.transaction(PROJECT_STORE, "readonly").objectStore(PROJECT_STORE).getAll());
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async loadActive(fallback: () => BoardDocument): Promise<SiteProject> {
    const activeId = await this.activeId();
    if (activeId) {
      const active = await this.get(activeId);
      if (active) return active;
    }
    const [latest] = await this.list();
    if (latest) {
      await this.setActive(latest.id);
      const project = await this.get(latest.id);
      if (project) return project;
    }
    return this.create("画布", fallback());
  }

  async get(id: string): Promise<SiteProject | undefined> {
    const database = await this.database();
    return request<SiteProject | undefined>(database.transaction(PROJECT_STORE, "readonly").objectStore(PROJECT_STORE).get(id));
  }

  async create(name: string, document: BoardDocument): Promise<SiteProject> {
    const now = Date.now();
    const project: SiteProject = {
      id: `site-project-${crypto.randomUUID()}`,
      name,
      createdAt: now,
      updatedAt: now,
      document,
    };
    const database = await this.database();
    await transactionDone(database.transaction(PROJECT_STORE, "readwrite"), (transaction) => {
      transaction.objectStore(PROJECT_STORE).put(project);
    });
    await this.setActive(project.id);
    return project;
  }

  async save(id: string, document: BoardDocument): Promise<void> {
    const current = await this.get(id);
    if (!current) return;
    const database = await this.database();
    await transactionDone(database.transaction(PROJECT_STORE, "readwrite"), (transaction) => {
      transaction.objectStore(PROJECT_STORE).put({ ...current, updatedAt: Date.now(), document });
    });
  }

  async rename(id: string, name: string): Promise<SiteProject | undefined> {
    const current = await this.get(id);
    if (!current) return undefined;
    const next = { ...current, name, updatedAt: Date.now() };
    const database = await this.database();
    await transactionDone(database.transaction(PROJECT_STORE, "readwrite"), (transaction) => {
      transaction.objectStore(PROJECT_STORE).put(next);
    });
    return next;
  }

  async delete(id: string, preserveActive = false): Promise<void> {
    const database = await this.database();
    await transactionDone(database.transaction([PROJECT_STORE, META_STORE], "readwrite"), (transaction) => {
      transaction.objectStore(PROJECT_STORE).delete(id);
      if (!preserveActive) transaction.objectStore(META_STORE).delete(ACTIVE_PROJECT_KEY);
    });
  }

  async setActive(id: string): Promise<void> {
    const database = await this.database();
    await transactionDone(database.transaction(META_STORE, "readwrite"), (transaction) => {
      transaction.objectStore(META_STORE).put(id, ACTIVE_PROJECT_KEY);
    });
  }

  async clear(): Promise<void> {
    const database = await this.database();
    await transactionDone(database.transaction([PROJECT_STORE, META_STORE], "readwrite"), (transaction) => {
      transaction.objectStore(PROJECT_STORE).clear();
      transaction.objectStore(META_STORE).clear();
    });
  }

  private async activeId(): Promise<string | undefined> {
    const database = await this.database();
    return request<string | undefined>(database.transaction(META_STORE, "readonly").objectStore(META_STORE).get(ACTIVE_PROJECT_KEY));
  }

  private database(): Promise<IDBDatabase> {
    this.#database ??= new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const database = open.result;
        if (!database.objectStoreNames.contains(PROJECT_STORE)) database.createObjectStore(PROJECT_STORE, { keyPath: "id" });
        if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("Failed to open site project store"));
      open.onblocked = () => reject(new Error("Site project store upgrade was blocked"));
    });
    return this.#database;
  }
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction, work: (transaction: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    work(transaction);
  });
}
