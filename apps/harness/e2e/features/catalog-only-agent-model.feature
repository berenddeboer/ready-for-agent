Feature: Agent Model selection is catalog-only
  Operators choose Agent Models from the Agent Backend's current catalog. A
  value left over from another provider mode stays visible but unusable, so
  configuration is never silently deleted and never silently accepted.

  Scenario: A stale Bedrock model is unavailable in first-party Harness Config
    Given the Harness runs Claude Code with a legacy Bedrock Agent Model
    When I open Harness settings
    Then the build model control is a dropdown, not a text box
    And the review model control is a dropdown, not a text box
    And the build model dropdown offers the first-party Claude aliases
    And the build model dropdown shows the legacy Bedrock value as unavailable
    And saving Harness settings is blocked
    And the build model explains that the selection is not in the catalog
    When I choose the build model "sonnet"
    Then saving Harness settings is allowed
    When I save Harness settings
    And I reopen Harness settings
    Then the build model dropdown has "sonnet" selected

  Scenario: A stale Repository override can be corrected or cleared
    Given the Harness runs Claude Code with the "sonnet" Agent Model
    And the Harness has no configured Repositories
    And the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    And the Repository stores a legacy Bedrock Agent Model override
    And I open Repository settings
    Then the Repository build model control is a dropdown, not a text box
    And the Repository build model dropdown shows the legacy Bedrock value as unavailable
    And saving Repository settings is blocked
    When I clear the Repository build model override
    Then saving Repository settings is allowed
    When I save Repository settings
    And I open Repository settings
    Then the Repository build model dropdown inherits the Harness default

  Scenario: Reopening Settings after a Harness restart re-fetches the catalog
    Given the Harness runs Claude Code with the "sonnet" Agent Model
    When I open Harness settings
    Then the build model dropdown offers the first-party Claude aliases
    When I close Harness settings
    And Claude Code stops being authenticated and the Harness restarts
    And I reopen Harness settings
    Then the build model dropdown offers no usable Agent Model
    And saving Harness settings is blocked
