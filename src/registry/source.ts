import { HostNotAllowedError, httpGetJson, type HttpDeps } from '../net/http.js';
import { factsFromPackument, type PackageFacts } from './facts.js';

export type FactsResult =
  | { kind: 'ok'; facts: PackageFacts }
  | { kind: 'not-in-snapshot' }
  | { kind: 'error'; reason: string };          // reason: short, no URLs with tokens, no bodies

export type RepoResult =
  | { kind: 'ok'; archived: boolean; pushedAt?: string; htmlUrl: string }
  | { kind: 'not-found' }
  | { kind: 'rate-limited' }
  | { kind: 'not-in-snapshot' }
  | { kind: 'error'; reason: string };

export interface FactsSource {
  mode: 'offline' | 'online';
  snapshotDate: string | null;
  packageFacts(name: string, versionSpec?: string): Promise<FactsResult>;
  repoStatus(owner: string, repo: string): Promise<RepoResult>;
}
