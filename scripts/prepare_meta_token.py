"""Derive the main Page token from the existing business system user."""
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse

def main():
    token = os.environ.get('FACEBOOK_SYSTEM_USER_TOKEN', '').strip()
    page = os.environ.get('FACEBOOK_PAGE_ID', '').strip()
    if not token or not page:
        sys.exit('System user token and main Page ID are required.')
    # Verify the stored system token has no scheduled expiry without logging it.
    debug_request = urllib.request.Request(
        'https://graph.facebook.com/v26.0/debug_token?' + urllib.parse.urlencode({'input_token': token}),
        headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(debug_request, timeout=30) as response:
            info = json.load(response).get('data', {})
        if not info.get('is_valid'):
            sys.exit('The business system user token is invalid.')
        if info.get('expires_at') == 0:
            print('Business system user token verified: no scheduled expiration.')
        else:
            print('::warning::Business system user token has a scheduled expiry or unknown expiration; replace it with a Never-expiring token in Meta Business Settings.')
    except urllib.error.HTTPError:
        print('::warning::Meta token expiration could not be verified; Page access will still be tested.')
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
