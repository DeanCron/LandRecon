import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AuthContext, type AuthApi } from './authContext'
import { AuthModal } from './AuthModal'
import { AccountMenu } from './AccountMenu'

function api(over: Partial<AuthApi> = {}): AuthApi {
  return {
    status: 'signedOut',
    user: null,
    signInWithGoogle: vi.fn().mockResolvedValue(null),
    signInWithEmail: vi.fn().mockResolvedValue(null),
    verifyEmailCode: vi.fn().mockResolvedValue(null),
    signOut: vi.fn().mockResolvedValue(undefined),
    deleteAccount: vi.fn().mockResolvedValue(null),
    openSignIn: vi.fn(),
    ...over,
  }
}

describe('AuthModal', () => {
  it('has no password field and moves to the code step after sending email', async () => {
    const a = api()
    const { container } = render(
      <AuthContext.Provider value={a}>
        <AuthModal onClose={() => {}} />
      </AuthContext.Provider>,
    )
    expect(container.querySelector('input[type="password"]')).toBeNull()
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } })
    fireEvent.click(screen.getByText('Email me a sign-in code'))
    await waitFor(() => expect(screen.getByLabelText('Code')).toBeTruthy())
    expect(a.signInWithEmail).toHaveBeenCalledWith('a@b.co')
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByText('Verify'))
    await waitFor(() => expect(a.verifyEmailCode).toHaveBeenCalledWith('a@b.co', '123456'))
  })

  it('shows errors', async () => {
    const a = api({ signInWithGoogle: vi.fn().mockResolvedValue('boom') })
    render(
      <AuthContext.Provider value={a}>
        <AuthModal onClose={() => {}} />
      </AuthContext.Provider>,
    )
    fireEvent.click(screen.getByText('Continue with Google'))
    expect((await screen.findByRole('alert')).textContent).toBe('boom')
  })
})

describe('AccountMenu', () => {
  it('renders nothing when auth is disabled', () => {
    const { container } = render(
      <AuthContext.Provider value={api({ status: 'disabled' })}>
        <AccountMenu />
      </AuthContext.Provider>,
    )
    expect(container.firstChild).toBeNull()
  })

  it('opens sign-in when signed out', () => {
    const a = api()
    render(
      <AuthContext.Provider value={a}>
        <AccountMenu />
      </AuthContext.Provider>,
    )
    fireEvent.click(screen.getByText('Sign in'))
    expect(a.openSignIn).toHaveBeenCalled()
  })
})
