import { Link } from 'react-router-dom'
import { loginUrl, logoutUrl } from './accountApi'
import { useAccount } from './useAccount'
import './account.css'

export default function AccountMenu() {
  const account = useAccount()
  if (account.status === 'loading') return null
  if (account.status === 'anonymous') {
    return (
      <nav className="account-menu" aria-label="Account">
        <span className="account-menu-label">Sign in to save addresses:</span>
        <a className="account-menu-link" href={loginUrl('google', '/account')}>Google</a>
        <a className="account-menu-link" href={loginUrl('aad', '/account')}>Microsoft</a>
      </nav>
    )
  }
  return (
    <nav className="account-menu" aria-label="Account">
      <span className="account-menu-label" title={account.user.name}>{account.user.name || 'Signed in'}</span>
      <Link className="account-menu-link" to="/account">My addresses</Link>
      <a className="account-menu-link" href={logoutUrl()}>Sign out</a>
    </nav>
  )
}
