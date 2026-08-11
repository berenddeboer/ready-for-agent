@no-backend
Feature: Default Agent Backend availability without OpenCode
  When coder CLIs are missing or only partially Ready, operators still get a
  healthy UI and clear first-run guidance: the default backend must not look
  silently Ready. Product behaviour lives here; packaging multi-arch remains
  overnight install smoke (#937 / #958).

  Scenario: Pure absence of Ready backends
    Given Claude Code reports unauthenticated
    When I open the home page for default-backend first-run guidance
    Then GraphQL health is true
    And the default Agent Backend status is UNAVAILABLE for opencode
    And Claude Code preview status is UNAVAILABLE
    And the UI shows default Agent Backend Unavailable guidance
    And the UI does not list Ready Agent Backend alternatives

  Scenario: Default missing with Claude Ready
    Given Claude Code reports first-party authenticated
    When I open the home page for default-backend first-run guidance
    Then GraphQL health is true
    And the default Agent Backend status is UNAVAILABLE for opencode
    And Claude Code preview status is READY
    And the UI shows default Agent Backend Unavailable guidance
    And the UI lists Ready Agent Backend alternative "claude"
