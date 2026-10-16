import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { versionStatus } from "../api/appVersion";

// Static nav structure. The "Department" / "Maintenance" sections are injected
// below depending on the logged-in user's role.
export const NAV_ITEMS = [
  {
    section: "Production",
    items: [
      { key: "supervisor",     label: "Supervisor Dashboard", icon: "/dashboard-icon.png", iconImg: true, path: "/YCA-SS/SUPERVISOR" },
      { key: "management",     label: "Management Dashboard", icon: "📊",                                 path: "/YCA-SS/MANAGEMENT" },
      { key: "management-2",   label: "Management Dashboard 2", icon: "📈",                               path: "/YCA-SS/MANAGEMENT-2" },
      { key: "cycle-videos",   label: "Cycle Videos",         icon: "🎬",                                 path: "/cycle-videos" },
    ],
  },
  {
    section: "Configuration",
    items: [
      { key: "machine-config", label: "Machine Config",       icon: "/settings-icon.png",  iconImg: true, path: "/machine-config" },
      { key: "camera",         label: "Camera Setting",       icon: "📷",                                 path: "/camera" },
    ],
  },
];

export default function SlideNav({ hideTrigger = false, raise = false }) {
  const [open, setOpen] = useState(false);
  const { user, token, logout, canAccess, isAdmin, isDepartment, isProduction, theme } = useAuth();
  const [escCount, setEscCount] = useState(0);   // pending escalations at my level (reminder badge)
  const navigate  = useNavigate();
  const location  = useLocation();
  const panelRef  = useRef(null);

  // Build a per-render copy of NAV_ITEMS that injects extra sections
  // depending on the role:
  //
  //   admin / plant_head : a "Maintenance" section is added so the
  //                         admin can jump directly to the Maintenance
  //                         Dashboard / Historical Data / CAPA without
  //                         having to log in as a maintenance user.
  //
  //   department user    : a "{DeptName}" section is added with the
  //                         pages relevant to that department.  For
  //                         maintenance it carries the Panel + Historical
  //                         + CAPA items.
  //
  //   anyone else        : the static NAV_ITEMS as-is.
  const navItems = NAV_ITEMS;   // demo: three pages, no roles

  // Close on outside click
  useEffect(() => {
    function handler(e) {
      if (open && panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    function handler(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Allow any page to open the menu by dispatching window event
  // "tbdi:open-nav".  Used by the header-logo click on the bare SUPERVISOR /
  // MANAGEMENT per-line views, which render <SlideNav/> without <Layout>.
  useEffect(() => {
    const openNav = () => setOpen(true);
    window.addEventListener("tbdi:open-nav", openNav);
    return () => window.removeEventListener("tbdi:open-nav", openNav);
  }, []);

  // Unread-notification count (badge on the Inbox item).
  useEffect(() => {
    setEscCount(0); return;   // demo: no inbox
    let alive = true;
    const tick = () => {
      fetch("/api/push/inbox", { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : {})
        .then(d => { if (alive) setEscCount(Number(d && d.unread) || 0); })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [user, token]);

  const go = (path) => { navigate(path); setOpen(false); };

  const isActive = (path) => {
    // The four /admin/* panels each get their own slide-nav row, so we
    // need *exact* path matches there — otherwise "/admin/production"
    // would also light up the bare "Admin Panel" row (since it
    // startsWith "/admin").
    if (path === "/admin")                   return location.pathname === "/admin";
    if (path === "/admin/production")        return location.pathname === "/admin/production";
    if (path === "/admin/maintenance")       return location.pathname === "/admin/maintenance";
    if (path === "/admin/quality")           return location.pathname === "/admin/quality";
    if (path === "/department-panel")        return location.pathname.startsWith("/department-panel");
    if (path === "/maintenance-dashboard")   return location.pathname.startsWith("/maintenance-dashboard");
    if (path === "/maintenance-historical")  return location.pathname.startsWith("/maintenance-historical");
    if (path === "/maintenance-capa")        return location.pathname.startsWith("/maintenance-capa");
    if (path === "/maintenance-deviations")  return location.pathname.startsWith("/maintenance-deviations");
    if (path === "/maintenance-poka-yoke")   return location.pathname.startsWith("/maintenance-poka-yoke");
    if (path === "/process-graphs")          return location.pathname.startsWith("/process-graphs");
    if (path === "/quality-dashboard")       return location.pathname.startsWith("/quality-dashboard");
    if (path === "/quality-deviations")      return location.pathname.startsWith("/quality-deviations");
    if (path === "/comments-history")        return location.pathname.startsWith("/comments-history");
    return location.pathname === path;
  };

  const roleLabel = () => {
   if (!user) return "";
   if (user.role === "admin")      return "Administrator";
   if (user.role === "plant_head") return "Plant Head";
   if (user.role === "department") return user.departmentName
                                            ? `${user.departmentName} Department`
                                            : "Department";
   if (user.role === "production") return "Production User";
   if (user.role === "operator")   return "Operator";
   return user.role;
  };

  return (
    <>
      {/* ── Floating Logo Button ── */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: (open || hideTrigger) ? "none" : "flex",
          position: "fixed",
          // + var(--cap-sat) so the trigger clears the Android status bar on the
          // installed app (the bar overlays the WebView there); 0 on web.
          top: "calc(13px + var(--cap-sat, 0px))",
          left: 30,
          width: 45,
          height: 45,
          borderRadius: "40%",
          border: "none",
          padding: 0,
          cursor: "pointer",
          zIndex: raise ? 2002 : 1000,
          boxShadow: open
            ? `0 0 0 3px ${theme.accent}, 0 8px 32px rgba(0,0,0,0.2)`
            : "0 2px 12px rgba(0,0,0,0.15)",
          transition: "box-shadow 0.2s ease, transform 0.2s ease",
          transform: open ? "scale(1.08)" : "scale(1)",
          overflow: "hidden",
          background: "#ffffff",
        }}
        aria-label="Toggle navigation"
      >
        <img
          src="/logo.jpg"
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
          onError={e => { e.target.style.display = "none"; }}
        />
      </button>

      {/* ── Backdrop ── */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.4)",
            backdropFilter: "blur(2px)",
            zIndex: raise ? 2000 : 998,
            animation: "fadeIn 0.15s ease",
          }}
        />
      )}

      {/* ── Slide Panel ── */}
      <div
        ref={panelRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: 260,
          height: "calc(100vh - 0px)",
          background: "var(--bg-secondary, #ffffff)",
          borderRight: "1px solid var(--border, #e2e8f0)",
          boxShadow: "4px 0 32px rgba(0,0,0,0.15)",
          zIndex: raise ? 2001 : 999,
          display: "flex",
          flexDirection: "column",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 0.28s cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        {/* Header */}
        <div style={{
          // + var(--cap-sat) so the drawer header (logo + org name) sits below
          // the Android status bar on the installed app; 0 on web.
          padding: "calc(24px + var(--cap-sat, 0px)) 20px 16px",
          borderBottom: "1px solid var(--border, #e2e8f0)",
          background: `linear-gradient(135deg, ${theme.accentDark}, ${theme.accent})`,
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div style={{
              width: 45, height: 45, borderRadius: 10,
              background: "rgba(255,255,255,0.15)",
              border: "1px solid rgba(255,255,255,0.25)",
              overflow: "hidden", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <img src="/logo.jpg" alt="logo"
                style={{ width: "100%", height: "100%", objectFit: "contain" }}
                onError={e => { e.target.style.display="none"; }}
              />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Toyota Boshoku</div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.65)", lineHeight: 1.4 }}>
                Device India
              </div>
            </div>
          </div>

          {/* User info */}
          <div style={{
            background: "rgba(255,255,255,0.1)",
            borderRadius: 8,
            padding: "10px 12px",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: "50%",
              background: "rgba(255,255,255,0.2)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, fontWeight: 700, color: "#fff", flexShrink: 0,
            }}>
              {user?.username?.[0]?.toUpperCase() || "?"}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {user?.username || "—"}
              </div>
              <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)" }}>
                {roleLabel()}
              </div>
            </div>
          </div>
        </div>

        {/* Nav items */}
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
          {navItems.map(group => {
            // Hide admin section from non-admins (plant_head is admin-equivalent).
            if (group.adminOnly && !isAdmin) return null;

            // Filter items by role
            const visibleItems = group.items.filter(item => item.external || canAccess(item.key));
            if (visibleItems.length === 0) return null;

            return (
              <div key={group.section}>
                <div style={{
                  padding: "12px 20px 6px",
                  fontSize: 10, fontWeight: 700,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: "var(--text-muted, #64748b)",
                }}>
                  {group.section}
                </div>
                {visibleItems.map(item => {
                  const active = isActive(item.path);
                  return (
                    <button
                      key={item.key}
                      onClick={() => item.external ? (window.open(item.url, "_blank", "noopener"), setOpen(false)) : go(item.path)}
                      style={{
                        display: "flex", alignItems: "center", gap: 12,
                        width: "calc(100% - 24px)",
                        margin: "2px 12px",
                        padding: "10px 16px",
                        borderRadius: 8,
                        border: active ? `1px solid ${theme.soft.replace(/\.0?\d+\)/, '.25)')}` : "1px solid transparent",
                        background: active ? theme.soft : "transparent",
                        color: active ? theme.accentDark : "var(--text-secondary, #334155)",
                        cursor: "pointer",
                        fontSize: 13, fontWeight: active ? 600 : 500,
                        textAlign: "left",
                        transition: "all 0.12s ease",
                      }}
                      onMouseEnter={e => {
                        if (!active) {
                          e.currentTarget.style.background = "var(--bg-primary, #f8fafc)";
                          e.currentTarget.style.color = "var(--text-primary, #0f172a)";
                        }
                      }}
                      onMouseLeave={e => {
                        if (!active) {
                          e.currentTarget.style.background = "transparent";
                          e.currentTarget.style.color = "var(--text-secondary, #334155)";
                        }
                      }}
                    >
                      <span style={{ width: 20, height: 20, textAlign: "center", fontSize: 15, flexShrink: 0, display:"inline-flex", alignItems:"center", justifyContent:"center" }}>
                        {item.iconImg
                          ? <img src={item.icon} alt="" style={{ width:18, height:18, objectFit:"contain" }}/>
                          : item.icon}
                      </span>
                      {item.label}
                      {item.key === "my-escalations" && escCount > 0 && (
                        <span style={{ marginLeft: "auto", minWidth: 18, height: 18, padding: "0 5px",
                                       borderRadius: 9, background: "#dc2626", color: "#fff",
                                       fontSize: 11, fontWeight: 800, display: "inline-flex",
                                       alignItems: "center", justifyContent: "center" }}>{escCount}</span>
                      )}
                      {active && item.key !== "my-escalations" && (
                        <span style={{
                          marginLeft: "auto",
                          width: 6, height: 6, borderRadius: "50%",
                          background: theme.accentDark, flexShrink: 0,
                        }} />
                      )}
                    </button>
                  );
                })}
                <div style={{ height: 1, background: "var(--border, #e2e8f0)", margin: "8px 16px" }} />
              </div>
            );
          })}
        </div>

        {/* Footer — app version status + Sign out */}
        <div style={{
          padding: "12px 16px 24px",
          borderTop: "1px solid var(--border, #e2e8f0)",
          flexShrink: 0,
        }}>
          {(() => {
            const vs = versionStatus();
            const outdated = vs.isApk && !vs.ok;
            return (
              <button
                onClick={() => outdated && (window.open("/download.html", "_blank", "noopener"), setOpen(false))}
                title={vs.isApk ? `${vs.label} · ${vs.detail}` : undefined}
                style={{
                  width: "100%", padding: "8px 12px", marginBottom: 8,
                  display: "flex", alignItems: "center", gap: 8,
                  background: "transparent", border: "1px solid var(--border, #e2e8f0)",
                  borderRadius: 8, cursor: outdated ? "pointer" : "default",
                  color: "var(--text-muted, #64748b)", fontSize: 12, fontWeight: 600,
                  textAlign: "left",
                }}
              >
                <span style={{ fontSize: 13 }}>{vs.ok ? "🟢" : "🟠"}</span>
                <span style={{ color: "var(--text-secondary, #334155)" }}>{vs.label}</span>
                <span style={{ marginLeft: "auto", color: vs.ok ? "#059669" : "#d97706", fontWeight: 700 }}>
                  {vs.detail}
                </span>
              </button>
            );
          })()}

        </div>
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
      `}</style>
    </>
  );
}
