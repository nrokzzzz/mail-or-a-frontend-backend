import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider } from './context/AuthContext';

// Layouts
import AppLayout from './layouts/AppLayout';
import AuthLayout from './layouts/AuthLayout';

// Pages — all imports unchanged
import Home from './pages/home/Home';
import Privacy from './pages/home/Privacy';
import Terms from './pages/home/Terms';

import Login from './pages/auth/Login';
import Signup from './pages/auth/Signup';
import ForgotPassword from './pages/auth/ForgotPassword';
import OTPVerification from './pages/auth/OTPVerification';
import ChangePassword from './pages/auth/ChangePassword';
import AuthCallback from './pages/auth/AuthCallback';
import AuthError from './pages/auth/AuthError';

import UpdateProfile from './pages/profile/UpdateProfile';
import ProfileChangePassword from './pages/profile/ProfileChangePassword';

import Dashboard from './pages/dashboard/Dashboard';
import JobsTable from './pages/dashboard/JobsTable';

// Core Styles
import './styles/global.css';
import './styles/layout.css';

function App() {
  return (
    // ThemeProvider → AuthProvider → BrowserRouter
    // Both context providers wrap the entire tree so every component can use them.
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* App Layout (Navbar + Footer) */}
            <Route element={<AppLayout />}>
              {/* Public routes */}
              <Route path="/"              element={<Home />} />
              <Route path="/home"          element={<Home />} />
              <Route path="/privacy-policy" element={<Privacy />} />
              <Route path="/terms"          element={<Terms />} />

              {/* App routes — accessible to all; API handles auth on the backend */}
              <Route path="/dashboard"               element={<Dashboard />} />
              <Route path="/jobs"                    element={<JobsTable />} />
              <Route path="/profile"                 element={<UpdateProfile />} />
              <Route path="/update-profile"          element={<UpdateProfile />} />
              <Route path="/profile/change-password" element={<ProfileChangePassword />} />
            </Route>

            {/* Auth Layout (Login/Signup flow) */}
            <Route element={<AuthLayout />}>
              <Route path="/login"           element={<Login />} />
              <Route path="/signup"          element={<Signup />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/otp"             element={<OTPVerification />} />
              <Route path="/change-password" element={<ChangePassword />} />
              <Route path="/auth/callback"   element={<AuthCallback />} />
              <Route path="/auth/error"      element={<AuthError />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

export default App;
