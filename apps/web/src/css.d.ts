// Type declarations for CSS side-effect imports (TypeScript 6+)
declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}
