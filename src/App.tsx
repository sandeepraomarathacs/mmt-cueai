import { Navigate, Route, Routes } from 'react-router-dom'
import LoginPage from './pages/LoginPage'
import SessionsPage from './pages/SessionsPage'
import LiveSessionPage from './pages/LiveSessionPage'

function Private({ children }: { children: React.ReactNode }) {
  if (!localStorage.getItem('token')) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<Private><SessionsPage /></Private>} />
      <Route path="/sessions/:id" element={<Private><LiveSessionPage /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
