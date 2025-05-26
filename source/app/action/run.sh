echo "::group::Metrics docker image setup"
echo "GitHub action: $METRICS_ACTION ($METRICS_ACTION_PATH)"
cd $METRICS_ACTION_PATH

# Check dependencies
for DEPENDENCY in docker jq; do
  if ! which $DEPENDENCY > /dev/null 2>&1; then
    echo "::error::\"$DEPENDENCY\" is not installed on current runner but is needed to run metrics"
    MISSING_DEPENDENCIES=1
  fi
done
if [[ $MISSING_DEPENDENCIES == "1" ]]; then
  exit 1
fi

# Create environment file
touch .env
for INPUT in $(echo $INPUTS | jq -r 'to_entries|map("INPUT_\(.key|ascii_upcase)=\(.value|@uri)")|.[]'); do
  echo $INPUT >> .env
done
env | grep -E '^(GITHUB|ACTIONS|CI|TZ)' >> .env

# Output folder
METRICS_RENDERS="/metrics_renders"
sudo mkdir -p $METRICS_RENDERS

# Extract source
METRICS_SOURCE=$(echo $METRICS_ACTION | sed -E 's/metrics.*?$//g' | sed -E 's/_//g')
echo "Source: $METRICS_SOURCE"

# Extract version
METRICS_VERSION=$(grep -Po '(?<="version": ").*(?=")' package.json)
echo "Version: $METRICS_VERSION"

# Tag
METRICS_TAG=v$(echo $METRICS_VERSION | sed -r 's/^([0-9]+[.][0-9]+).*/\1/')
echo "Image tag: $METRICS_TAG"

# Determine image source
if [[ $METRICS_SOURCE == "lowlighter" ]]; then
  if [[ ! $METRICS_USE_PREBUILT_IMAGE =~ ^([Ff]alse|[Oo]ff|[Nn]o|0)$ ]]; then
    set +e
    METRICS_IS_RELEASED=$(expr $(expr match $METRICS_VERSION .*-beta) == 0)
    set -e
    if [[ "$METRICS_IS_RELEASED" -eq "0" ]]; then
      METRICS_TAG="$METRICS_TAG-beta"
    fi
    METRICS_IMAGE=ghcr.io/lowlighter/metrics:$METRICS_TAG
    if ! docker image pull $METRICS_IMAGE; then
      METRICS_IMAGE=metrics:$METRICS_VERSION
    fi
  else
    METRICS_IMAGE=metrics:$METRICS_VERSION
  fi
else
  # Fork (e.g. DeadCodeGames)
  if [[ ! $METRICS_USE_PREBUILT_IMAGE =~ ^([Ff]alse|[Oo]ff|[Nn]o|0)$ ]]; then
    METRICS_IMAGE=ghcr.io/deadcodegames/metrics
    echo "Trying to pull prebuilt image: $METRICS_IMAGE"
    if ! docker image pull $METRICS_IMAGE; then
      echo "Failed to pull image, will rebuild locally"
      METRICS_IMAGE=metrics:forked-$METRICS_VERSION
    fi
  else
    METRICS_IMAGE=metrics:forked-$METRICS_VERSION
  fi
fi

echo "Using Docker image: $METRICS_IMAGE"

# Build if missing
set +e
docker image inspect $METRICS_IMAGE > /dev/null 2>&1
METRICS_IMAGE_NEEDS_BUILD="$?"
set -e
if [[ "$METRICS_IMAGE_NEEDS_BUILD" -gt "0" ]]; then
  docker build -t $METRICS_IMAGE .
fi
echo "::endgroup::"

# Run the container
docker run --init --rm --volume $GITHUB_EVENT_PATH:$GITHUB_EVENT_PATH --volume $METRICS_RENDERS:/renders --env-file .env $METRICS_IMAGE
rm .env
