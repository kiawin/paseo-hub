import { randomUUID } from "node:crypto";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { DatabaseRuntime } from "../runtime/index.js";
import { startPostgresContainer } from "./postgres-container.js";
import { createPostgresQueryRuntime } from "./runtime.js";

/** What a test needs from its Postgres: where to connect, and how to throw it away. */
export interface TestPostgres {
  getConnectionUri(): string;
  stop(): Promise<unknown>;
}

/**
 * One Postgres container shared by the tests of a file, which hands each test its own empty
 * database. Starting a container per test is slow, and every start is another chance for Docker
 * Desktop to miss testcontainers' fixed 10-second port wait. A database per test keeps the
 * isolation a container per test gave.
 */
export class SharedPostgres {
  private constructor(
    private readonly container: StartedPostgreSqlContainer,
    private readonly admin: DatabaseRuntime,
  ) {}

  static async start(): Promise<SharedPostgres> {
    const container = await startPostgresContainer();
    try {
      return new SharedPostgres(
        container,
        await createPostgresQueryRuntime(container.getConnectionUri()),
      );
    } catch (error) {
      await container.stop().catch(() => undefined);
      throw error;
    }
  }

  /** Creates an empty database. Stopping it drops the database and ends its open connections. */
  async database(): Promise<TestPostgres> {
    const name = `test_${randomUUID().replaceAll("-", "")}`;
    await this.admin.query(`create database "${name}"`);
    const url = new URL(this.container.getConnectionUri());
    url.pathname = `/${name}`;
    const connectionUri = url.toString();
    return {
      getConnectionUri: () => connectionUri,
      stop: () => this.admin.query(`drop database if exists "${name}" with (force)`),
    };
  }

  async stop(): Promise<void> {
    try {
      await this.admin.close();
    } finally {
      await this.container.stop();
    }
  }
}
