import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth";
import AuthPage from "./pages/AuthPage";
import CanvasList from "./pages/CanvasList";
import CanvasPage from "./pages/CanvasPage";
import "./styles.css";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/" element={<RequireAuth><CanvasList /></RequireAuth>} />
          <Route path="/canvas/:id" element={<RequireAuth><CanvasPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
