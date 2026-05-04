/**
 * ProtectedRoute.jsx
 * Guards private routes: redirects to /login if user is not authenticated.
 * Saves the attempted URL in location.state.from so Login can redirect back.
 */
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

const ProtectedRoute = () => {
  const { isLoggedIn } = useAuth();
  const location = useLocation();

  if (!isLoggedIn) {
    // Pass attempted path so Login page can redirect back after auth
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
};

export default ProtectedRoute;
