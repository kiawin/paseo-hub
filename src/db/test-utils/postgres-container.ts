import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

const IMAGE = "postgres:17-alpine";
const ATTEMPTS = 3;
const PORT_BINDING_TIMEOUT = "while waiting for container ports to be bound to the host";

/** Start a throwaway PostgreSQL container for a test, retrying a slow Docker port binding. */
export function startPostgresContainer(
  configure: (container: PostgreSqlContainer) => PostgreSqlContainer = (container) => container,
): Promise<StartedPostgreSqlContainer> {
  return retryPortBindingTimeout(() => configure(new PostgreSqlContainer(IMAGE)).start());
}

/**
 * testcontainers gives Docker a fixed 10 seconds to publish a new container's ports, with no option
 * to raise it. Docker Desktop sometimes takes longer when tests start many containers back to back.
 * That timeout says nothing about the code under test, so it is retried; any other error fails at
 * once.
 */
export async function retryPortBindingTimeout<T>(start: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await start();
    } catch (error) {
      if (attempt >= ATTEMPTS || !isPortBindingTimeout(error)) throw error;
    }
  }
}

function isPortBindingTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes(PORT_BINDING_TIMEOUT);
}
