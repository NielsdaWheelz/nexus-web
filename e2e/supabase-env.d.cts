interface SupabaseE2EEnv {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly adminKey: string | null | undefined;
}

interface RequiredSupabaseE2EEnv extends SupabaseE2EEnv {
  readonly adminKey: string;
}

interface SupabaseEnvOptions {
  readonly loadFiles?: boolean;
  readonly requireAdmin?: boolean;
}

declare const supabaseEnv: {
  applySupabasePublicEnv(
    rootDir: string,
    env?: NodeJS.ProcessEnv,
    options?: SupabaseEnvOptions,
  ): SupabaseE2EEnv;
  buildE2eAppRuntimeEnv(sourceEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  loadRootFileEnv(rootDir: string): Record<string, string>;
  requireSupabaseAdminEnv(
    rootDir: string,
    env?: NodeJS.ProcessEnv,
    options?: SupabaseEnvOptions,
  ): RequiredSupabaseE2EEnv;
  resolveSupabaseE2EEnv(
    rootDir: string,
    env?: NodeJS.ProcessEnv,
    options?: SupabaseEnvOptions,
  ): SupabaseE2EEnv;
};

export = supabaseEnv;
