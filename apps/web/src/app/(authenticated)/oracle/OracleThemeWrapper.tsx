export default function OracleThemeWrapper({ children }: { children: React.ReactNode }) {
  return (
    <div data-theme="oracle" style={{ display: "contents" }}>
      {children}
    </div>
  );
}
