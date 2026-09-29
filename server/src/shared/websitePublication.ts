/** Transport options shared by the editor and publication commands. */
export interface PublicationOptions {
  ifRevision?: number;
  sourceHash?: string;
  mode?: "commit" | "pull_request";
  prTitle?: string;
  forceOverride?: boolean;
}
