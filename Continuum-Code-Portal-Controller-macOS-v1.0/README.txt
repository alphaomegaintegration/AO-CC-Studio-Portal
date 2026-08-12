Continuum Code Portal Controller for macOS
===========================================

INSTALL

1. Unzip Continuum-Code-Portal-Controller-macOS.zip.
2. Drag "Continuum Code Portal Controller.app" into Applications.
3. The first time, Control-click or right-click the app and choose Open.
4. Select an AWS SSO profile and click Login to AWS.

The app runs without a Terminal window.

PREREQUISITES

- Python 3 with Tkinter. The installer from https://www.python.org includes it.
- AWS CLI v2.
- An AWS SSO profile authorized for the Continuum Code AWS account.

If the preferred profile is not configured, select another profile from the
list or type its name. Each colleague uses their own AWS access.

AWS RESOURCES CONTROLLED

- Account: 945824236547
- Region: us-east-1
- Cluster: default
- Services: ao-cc-studio and ao-cc-discovery

The app permits only desired counts 0 and 1. It does not contain or store AWS
credentials.

TROUBLESHOOTING

Application log:
~/Library/Logs/Continuum Code Portal Controller/controller.log

If AWS login expires, click Login to AWS again.
