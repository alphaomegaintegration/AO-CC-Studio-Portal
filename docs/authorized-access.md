Yes, this is possible—and it does not have to be limited to AWS users.

Use two separate controls:

1. **Authentication:** The user signs in with their existing AO corporate system ID and password.
2. **Authorization:** After AO verifies the login, the portal checks the verified user against an approved-access list.

The login flow would be:

```text
Portal → AO corporate login → identity verified → authorized-user list checked → access granted/denied
```

The portal should never receive or store the AO password. It should redirect users to AO’s existing identity provider—likely Microsoft Entra ID, Okta, Active Directory, or another corporate login service—and receive a verified identity token.

For the authorization list, use the employee’s corporate email address or permanent employee/user ID, not just their displayed name. Names can be duplicated or changed.

Example:

| Corporate user ID                                   | Studio | Discovery | Active |
| --------------------------------------------------- | -----: | --------: | -----: |
| [user1@alphaomega.com](mailto:user1@alphaomega.com) |    Yes |       Yes |    Yes |
| [user2@alphaomega.com](mailto:user2@alphaomega.com) |     No |       Yes |    Yes |

If AO uses Microsoft/Windows credentials, AO IT would need to provide the Entra ID, OIDC, or SAML connection information. AWS can host the portals while AO’s corporate system performs the login.

One limitation: external customers who do not have AO corporate accounts would need a separate invitation-based login option.

A suitable acceptance criterion is:

> Users shall authenticate using their existing AO corporate system credentials. After successful authentication, the system shall verify the user’s unique corporate email address or user ID against the portal’s authorized-user list. Authenticated users who are not on the list shall be denied access.
