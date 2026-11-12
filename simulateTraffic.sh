#!/bin/bash

# Steady, realistic traffic for monitoring JWT Pizza Service until a fixed end time.
# Unlike generatePizzatraffic.sh, it never orders too many pizzas on purpose, so any
# failed order or factory error comes from a real problem rather than from this script.
# Every session it opens is logged out when it stops, including when it is cancelled.

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <host> <end time>"
  echo "Example: $0 http://localhost:2999 \"\$(date -u -d '+5 minutes' +%s)\""
  exit 1
fi
host=$1
end=$2

sessions=$(mktemp -d)

# Stop every loop, then log out any session that is still open
cleanup() {
  trap - EXIT INT TERM
  kill $(jobs -p) 2> /dev/null
  wait 2> /dev/null
  for file in "$sessions"/*; do
    [ -f "$file" ] || continue
    result=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE $host/api/auth -H "Authorization: Bearer $(cat "$file")")
    echo "$(timestamp) Logging out $(basename "$file")... $result"
  done
  rm -rf "$sessions"
  echo "$(timestamp) Traffic stopped"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

timestamp() {
  date -u +%H:%M:%S
}

running() {
  [ "$(date +%s)" -lt "$end" ]
}

# Sleep, waking early once the end time has passed. Fails when it is time to stop.
pause() {
  local remaining=$1
  while [ "$remaining" -gt 0 ]; do
    running || return 1
    sleep 1
    remaining=$((remaining - 1))
  done
  running
}

# Wrap curl command to return HTTP response codes
execute_curl() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

# Log in and remember the token under the given name so cleanup can log it out
login() {
  local name=$1
  local token
  token=$(curl -s -X PUT $host/api/auth -d "{\"email\":\"$2\", \"password\":\"$3\"}" -H 'Content-Type: application/json' | sed -nE 's/.*"token":"([^"]*)".*/\1/p')
  [ -n "$token" ] && echo "$token" > "$sessions/$name"
  echo "$token"
}

logout() {
  local name=$1
  local result
  result=$(execute_curl -X DELETE $host/api/auth -H "Authorization: Bearer $(cat "$sessions/$name")")
  rm -f "$sessions/$name"
  echo "$result"
}

# Simulate a user requesting the menu every 3 seconds
while running; do
  echo "$(timestamp) Requesting menu... $(execute_curl $host/api/order/menu)"
  pause 3 || break
done &

# Simulate a user with an invalid email and password every 25 seconds
while running; do
  result=$(execute_curl -X PUT $host/api/auth -d '{"email":"unknown@jwt.com", "password":"bad"}' -H 'Content-Type: application/json')
  echo "$(timestamp) Logging in with invalid credentials... $result"
  pause 25 || break
done &

# Simulate a franchisee checking their franchises every two minutes
while running; do
  token=$(login franchisee "f@jwt.com" "franchisee")
  echo "$(timestamp) Login franchisee... $([ -z "$token" ] && echo "false" || echo "true")"
  if [ -n "$token" ]; then
    echo "$(timestamp) Viewing franchises... $(execute_curl "$host/api/franchise?page=0&limit=10&name=*" -H "Authorization: Bearer $token")"
    pause 110
    echo "$(timestamp) Logging out franchisee... $(logout franchisee)"
  fi
  pause 10 || break
done &

# Simulate a diner who orders a pizza about every 10 seconds, logging back in after every 5 orders
while running; do
  token=$(login diner "d@jwt.com" "diner")
  echo "$(timestamp) Login diner... $([ -z "$token" ] && echo "false" || echo "true")"
  if [ -n "$token" ]; then
    for ((i = 0; i < 5; i++)); do
      result=$(execute_curl -X POST $host/api/order -H 'Content-Type: application/json' -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.0038 }]}' -H "Authorization: Bearer $token")
      echo "$(timestamp) Bought a pizza... $result"
      execute_curl $host/api/order -H "Authorization: Bearer $token" > /dev/null
      pause 10 || break
    done
    echo "$(timestamp) Logging out diner... $(logout diner)"
  fi
  pause 5 || break
done &

wait
