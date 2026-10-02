# Drops the local database, lets the service recreate it, and loads the sample data from generatePizzaData.sh.
# Connection settings are read from src/config.js.
#
# Usage: ./resetDatabase.sh [--yes] [port]
set -e

cd "$(dirname "$0")"

if [ "$1" = "--yes" ]; then
  confirmed=true
  shift
fi
port=${1:-3999}
host="http://localhost:$port"

database=$(node -e "console.log(require('./src/config.js').db.connection.database)")

if [ "$confirmed" != true ]; then
  read -p "This permanently deletes all data in the '$database' database. Continue? (y/N) " answer
  if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
    echo "Aborted"
    exit 1
  fi
fi

# Drop the database
node -e "
const mysql = require('mysql2/promise');
const { connection: c } = require('./src/config.js').db;
(async () => {
  const connection = await mysql.createConnection({ host: c.host, user: c.user, password: c.password });
  await connection.query(\`DROP DATABASE IF EXISTS \\\`\${c.database}\\\`\`);
  await connection.end();
})();
"
echo "Dropped database '$database'"

# Start the service, which recreates the database, tables, and default admin
node src/index.js "$port" > /dev/null &
server_pid=$!
trap 'kill $server_pid 2> /dev/null' EXIT

# Wait until the default admin can log in
for attempt in $(seq 1 30); do
  if curl -s -X PUT "$host/api/auth" -d '{"email":"a@jwt.com", "password":"admin"}' -H 'Content-Type: application/json' | grep -q '"token"'; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "Service did not start on $host"
    exit 1
  fi
  sleep 1
done

./generatePizzaData.sh "$host" > /dev/null 2>&1
echo "Database '$database' reset with sample data:"

node -e "
const mysql = require('mysql2/promise');
const { connection: c } = require('./src/config.js').db;
(async () => {
  const connection = await mysql.createConnection(c);
  for (const table of ['user', 'menu', 'franchise', 'store']) {
    const [[{ count }]] = await connection.query(\`SELECT COUNT(*) AS count FROM \${table}\`);
    console.log(\`  \${table}: \${count}\`);
  }
  await connection.end();
})();
"
