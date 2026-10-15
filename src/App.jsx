import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import SlideNav from "./components/SlideNav";

const WallboardLeft = lazy(() => import("./pages/WallboardLeft"));
const Fullscreen = lazy(() => import("./pages/Fullscreen"));
const Management2 = lazy(() => import("./pages/Management2"));
const MachineConfig = lazy(() => import("./pages/MachineConfig"));
const CameraConfig = lazy(() => import("./pages/CameraConfig"));
const CycleVideos = lazy(() => import("./pages/CycleVideos"));

// Same page shell the MES uses for non-wallboard pages (Layout.jsx): light page + floating SlideNav.
function Shell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: 14 }}>
      {children}
      <SlideNav />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={null}>
          <Routes>
            <Route path="/:lineId/SUPERVISOR" element={<WallboardLeft />} />
            <Route path="/:lineId/MANAGEMENT" element={<Fullscreen />} />
            <Route path="/:lineId/MANAGEMENT-2" element={<Management2 />} />
            <Route path="/machine-config" element={<Shell><MachineConfig /></Shell>} />
            <Route path="/camera" element={<Shell><CameraConfig /></Shell>} />
            <Route path="/cycle-videos" element={<Shell><CycleVideos /></Shell>} />
            <Route path="*" element={<Navigate to="/YCA-SS/SUPERVISOR" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
