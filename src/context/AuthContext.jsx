// Standalone demo: NO login. Same API surface as MES AuthContext so copied
// components (SlideNav, PageTopbar, WallboardLeft) work unchanged.
import { createContext, useContext } from "react";

const AuthContext = createContext(null);

const USER = {
  id: 1, username: "demo", role: "admin",
  departmentId: null, departmentName: null, departmentSlug: null,
  permissions: {}, assignedLines: [], scope: { lines: {}, machines: {} },
};
const THEME = {
  accent: "#2563eb", accentDark: "#1e40af",
  gradient: "linear-gradient(90deg,#1e40af,#2563eb,#60a5fa)",
  soft: "rgba(30,64,175,.08)", key: "blue",
};
const yes = () => true;

const VALUE = {
  token: "demo", user: USER, loading: false,
  login: async () => ({}), loginWithToken: async () => true, logout: () => {},
  authHdr: () => ({ "Content-Type": "application/json" }),
  isAdmin: true, isPlantHead: false, isDepartment: false, isProduction: false, isOperator: false,
  isSectionIncharge: false, isProductionIncharge: false, isQualityIncharge: false, isIncharge: false,
  canAccess: yes, canAccessModule: yes, canWrite: yes, API: "",
  canAccessLine: yes, canAccessMachine: yes, canWriteLine: yes, canWriteMachine: yes,
  filterLines: (rows) => rows,
  theme: THEME, themeKey: "blue",
};

export function AuthProvider({ children }) {
  return <AuthContext.Provider value={VALUE}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
