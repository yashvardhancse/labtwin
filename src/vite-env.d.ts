/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Repository URL shown as the "Source" link; set by the deploy workflow. */
  readonly VITE_REPO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
