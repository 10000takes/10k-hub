"""Derive the main Page token from the existing business system user."""
import json
import os
import sys
import urllib.request
import urllib.error

def main():
    token = os.environ.get('FACEBOOK_SYSTEM_USER_TOKEN', '').strip()
    page = os.environ.get('FACEBOOK_PAGE_ID', '').strip()
    if not token or not page:
        sys.exit('System user token and main Page ID are required.')
    request = urllib.request.Request(
        'https://graph.facebook.com/v26.0/' + page + '?fields=access_token',
        headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            page_token = json.load(response).get('access_token', '')
    except urllib.error.HTTPError as error:
        sys.exit('Unable to derive main Page token (HTTP %s). Check system user access and token validity.' % error.code)
    if not page_token or '\n' in page_token or '\r' in page_token:
        sys.exit('Meta returned no valid Page token.')
    print('::add-mask::' + page_token)
    with open(os.environ['GITHUB_ENV'], 'a') as output:
        output.write('FACEBOOK_PAGE_TOKEN=' + page_token + '\n')
    print('Main Page credential prepared from business system user; no personal-session token used.')

if __name__ == '__main__':
    main()
